/* DeliveryCalculatorClass.js
 * Robust DeliveryCalculator for Yandex.Maps API 2.1
 * - Builds a route between A and B
 * - Styles and fits the route
 * - Updates an on‑map info panel (#routeInfo) with Distance / Time / Cost
 * - Updates start/finish balloons with the same data and auto-opens finish balloon
 * Public API:
 *   new DeliveryCalculator(map)
 *   setPoint('start'|'finish', [lat, lon], balloonContent?)
 *   setRoute([lat, lon], [lat, lon])
 *   clearRoute()
 */

ymaps.modules.define(
    'DeliveryCalculator',
    ['util.defineClass', 'vow'],
    function (provide, defineClass, vow) {

        /** ------------------------------
         *  Configuration
         *  ------------------------------ */
        var DELIVERY_TARIF = 20;  // ₽/₾ per km (edit as needed)
        var MINIMUM_COST   = 500; // Min delivery cost

        /** ------------------------------
         *  Helpers
         *  ------------------------------ */

        /**
         * Format seconds to "H h M min" or "M min".
         * @param {number|null|undefined} sec
         * @returns {string|null}
         */
        function formatSecondsToHm(sec) {
            if (sec == null || isNaN(sec)) return null;
            sec = Math.max(0, Math.floor(sec));
            var h = Math.floor(sec / 3600);
            var m = Math.floor((sec % 3600) / 60);
            return (h > 0 ? (h + ' h ') : '') + m + ' min';
        }

        /**
         * Update floating panel values if the panel exists.
         * @param {string} distanceText
         * @param {number} price
         * @param {number|null} seconds
         */
        function updatePanel(distanceText, price, seconds) {
            try {
                var dEl = document.getElementById('distanceVal');
                var tEl = document.getElementById('timeVal');
                var cEl = document.getElementById('costVal');
                if (dEl) dEl.textContent = distanceText || '—';
                if (tEl) tEl.textContent = (seconds || seconds === 0) ? (formatSecondsToHm(seconds) || '—') : '—';
                if (cEl) cEl.textContent = (price != null ? price : '—') + ' ₾';
            } catch (e) {
                // Silent; panel is optional
                // console.warn('updatePanel failed', e);
            }
        }

        /**
         * Extract duration (seconds) from a Yandex router if possible.
         * Tries multiple APIs because availability differs by routing mode.
         * @param {Object} router
         * @param {number} lengthMeters
         * @returns {number|null}
         */
        function getDurationSeconds(router, lengthMeters) {
            // 1) Direct methods (if provided by this router implementation)
            try {
                if (typeof router.getJamsTime === 'function') {
                    var jt = router.getJamsTime();
                    if (typeof jt === 'number' && jt >= 0) return jt;
                }
                if (typeof router.getTime === 'function') {
                    var t = router.getTime();
                    if (typeof t === 'number' && t >= 0) return t;
                }
            } catch (e) {}

            // 2) Properties blob
            try {
                if (router.properties && typeof router.properties.get === 'function') {
                    var dur = router.properties.get('duration'); // often {text, value}
                    if (dur && typeof dur.value === 'number') return dur.value;
                    if (dur && typeof dur.duration === 'number') return dur.duration;
                }
            } catch (e) {}

            // 3) Fallback: assume 40 km/h average speed
            var avgKmh = 40;
            var seconds = Math.round((lengthMeters / 1000) / avgKmh * 3600);
            return seconds;
        }

        /**
         * Build a delivery price from km.
         * @param {number} kmRounded
         * @returns {number}
         */
        function buildPrice(kmRounded) {
            return Math.max(kmRounded * DELIVERY_TARIF, MINIMUM_COST);
        }

        /** ------------------------------
         *  Class
         *  ------------------------------ */
        function DeliveryCalculator(map) {
            this._map = map;

            this._startPoint = null;
            this._finishPoint = null;

            this._route = null;   // ymaps.GeoObjectCollection of route paths
            this._router = null;  // original router object

            this._startPointBalloonContent = '';
            this._finishPointBalloonContent = '';

            this._deferred = null;

            // Allow picking/adjusting points by clicking on map.
            map.events.add('click', this._onClick, this);
        }

        DeliveryCalculator.prototype = defineClass({

            /**
             * Set a point by role.
             * @param {'start'|'finish'} role
             * @param {number[]} coords [lat, lon]
             * @param {string=} balloonContent
             */
            setPoint: function (role, coords, balloonContent) {
                var isStart = (role === 'start');
                var point = isStart ? this._startPoint : this._finishPoint;

                if (!point) {
                    point = new ymaps.Placemark(
                        coords,
                        { iconContent: isStart ? 'A' : 'B' },
                        { draggable: true }
                    );
                    this._map.geoObjects.add(point);
                    point.events.add('dragend', this._setupRoute, this);
                    if (isStart) this._startPoint = point;
                    else this._finishPoint = point;
                } else {
                    point.geometry.setCoordinates(coords);
                }

                if (typeof balloonContent === 'string') {
                    if (isStart) this._startPointBalloonContent = balloonContent;
                    else this._finishPointBalloonContent = balloonContent;
                }
            },

            /**
             * Convenience: set both points and build route.
             * @param {number[]} start
             * @param {number[]} finish
             */
            setRoute: function (start, finish) {
                this.setPoint('start', start);
                this.setPoint('finish', finish);
                this._setupRoute();
            },

            /**
             * Remove current route from the map.
             */
            clearRoute: function () {
                if (this._route) {
                    try { this._map.geoObjects.remove(this._route); } catch (e) {}
                    this._route = null;
                }
                this._router = null;
                // Do not clear markers.
            },

            /**
             * Internal: build/update the route and all UI.
             */
            _setupRoute: function () {
                if (!this._startPoint || !this._finishPoint) return;

                var start = this._startPoint.geometry.getCoordinates();
                var finish = this._finishPoint.geometry.getCoordinates();
                var startBalloon = this._startPointBalloonContent || '';
                var finishBalloon = this._finishPointBalloonContent || '';

                // Cancel previous async if pending
                if (this._deferred && !this._deferred.promise().isResolved()) {
                    this._deferred.reject('New request');
                }
                var deferred = (this._deferred = vow.defer());

                var self = this;

                ymaps.route([start, finish]).then(function (router) {
                    if (deferred.promise().isRejected()) return;

                    // Remove previous route
                    self.clearRoute();

                    // Save router
                    self._router = router;

                    // Compute stats
                    var lengthMeters = router.getLength();
                    var distanceText = ymaps.formatter.distance(lengthMeters);
                    var kmRounded = Math.round(lengthMeters / 1000);
                    var price = buildPrice(kmRounded);
                    var seconds = getDurationSeconds(router, lengthMeters);

                    // Draw route
                    self._route = router.getPaths();
                    self._route.options.set({
                        strokeWidth: 5,
                        strokeColor: '0000ffff',
                        opacity: 0.5
                    });
                    self._map.geoObjects.add(self._route);

                    // Update balloons
                    var message =
                        '<span>Distance: ' + distanceText + '.</span><br/>' +
                        '<span style="font-weight: bold; font-style: italic">Cost of delivery: ' + price + ' ₾</span>';
                    try {
                        self._startPoint.properties.set('balloonContentBody', startBalloon + message);
                        self._finishPoint.properties.set('balloonContentBody', finishBalloon + message);
                    } catch (e) {}

                    // Open finish balloon
                    try {
                        self._finishPoint.balloon.open().then(function () {
                            self._finishPoint.balloon.autoPan();
                        });
                    } catch (e) {}

                    // Update info panel
                    updatePanel(distanceText, price, seconds);

                    // Fit bounds
                    try {
                        self._map.setBounds(self._route.getBounds(), { checkZoomRange: true });
                    } catch (e) {}

                    deferred.resolve();
                }, function () {
                    // Route failure
                    try {
                        self._finishPoint.properties.set('balloonContentBody', "Can't build route");
                        self._finishPoint.balloon.open();
                        self._finishPoint.balloon.autoPan();
                    } catch (e) {}
                });
            },

            /**
             * Map click handler: first click sets start, second sets finish,
             * subsequent clicks move the finish point.
             * @param {Object} event
             */
            _onClick: function (event) {
                var pos = event.get('coords');
                if (!this._startPoint) {
                    this.setPoint('start', pos);
                } else if (!this._finishPoint) {
                    this.setPoint('finish', pos);
                } else {
                    this.setPoint('finish', pos);
                }
                this._setupRoute();
            }
        });

        provide(DeliveryCalculator);
    }
);
