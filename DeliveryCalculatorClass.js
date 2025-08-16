/* DeliveryCalculatorClass.js (robust) */
ymaps.modules.define(
  'DeliveryCalculator',
  ['util.defineClass', 'vow'],
  function (provide, defineClass, vow) {

    var DELIVERY_TARIF = 0.80;  // per-km rate
    var MINIMUM_COST   = 1; // minimum price

    function fmtMoney(v) {
      if (v == null || isNaN(v)) return '—';
      return (Math.round(v * 100) / 100).toFixed(2);
    }
    function fmtSeconds(sec) {
      if (sec == null || isNaN(sec)) return null;
      sec = Math.max(0, Math.floor(sec));
      var h = Math.floor(sec / 3600);
      var m = Math.floor((sec % 3600) / 60);
      return (h > 0 ? (h + ' h ') : '') + m + ' min';
    }
    function updatePanel(distanceText, seconds, price) {
      try {
        var d = document.getElementById('distanceVal');
        var t = document.getElementById('timeVal');
        var c = document.getElementById('costVal');
        if (d) d.textContent = (distanceText || '—');
        if (t) t.textContent = seconds != null ? (fmtSeconds(seconds) || '—') : '—';
        if (c) c.textContent = (price != null ? fmtMoney(price) : '—') + ' ₾';
      } catch(e) {}
    }
    function getDurationSeconds(router, lengthMeters) {
      try {
        if (typeof router.getJamsTime === 'function') {
          var jt = router.getJamsTime();
          if (typeof jt === 'number' && jt >= 0) return jt;
        }
        if (typeof router.getTime === 'function') {
          var t = router.getTime();
          if (typeof t === 'number' && t >= 0) return t;
        }
      } catch(e) {}
      try {
        if (router.properties && typeof router.properties.get === 'function') {
          var dur = router.properties.get('duration'); // {text, value}? depends
          if (dur && typeof dur.value === 'number') return dur.value;
          if (dur && typeof dur.duration === 'number') return dur.duration;
        }
      } catch(e) {}
      // fallback 40 km/h
      return Math.round((lengthMeters / 1000) / 40 * 3600);
    }
    function priceForKm(kmRounded) {
      return Math.max(kmRounded * DELIVERY_TARIF, MINIMUM_COST);
    }

    function DeliveryCalculator(map) {
      this._map = map;
      this._startPoint = null;
      this._finishPoint = null;
      this._route = null;
      this._router = null;
      this._startPointBalloonContent = '';
      this._finishPointBalloonContent = '';
      this._deferred = null;

      map.events.add('click', this._onClick, this);
    }

    DeliveryCalculator.prototype = defineClass({
      setPoint: function (which, coords, balloonContent) {
        var isStart = which === 'start';
        var pm = isStart ? this._startPoint : this._finishPoint;
        if (!pm) {
          pm = new ymaps.Placemark(
            coords,
            { iconContent: isStart ? 'A' : 'B' },
            { draggable: true }
          );
          this._map.geoObjects.add(pm);
          pm.events.add('dragend', this._setupRoute, this);
          if (isStart) this._startPoint = pm; else this._finishPoint = pm;
        } else {
          pm.geometry.setCoordinates(coords);
        }
        if (typeof balloonContent === 'string') {
          if (isStart) this._startPointBalloonContent = balloonContent;
          else this._finishPointBalloonContent = balloonContent;
        }

        // auto build route when we have both points
        if (this._startPoint && this._finishPoint) {
          this._setupRoute();
        }
      },

      setRoute: function (start, finish) {
        this.setPoint('start', start);
        this.setPoint('finish', finish);
      },

      _setupRoute: function () {
        if (!(this._startPoint && this._finishPoint)) return;

        var start = this._startPoint.geometry.getCoordinates();
        var finish = this._finishPoint.geometry.getCoordinates();
        var startBalloon = this._startPointBalloonContent || '';
        var finishBalloon = this._finishPointBalloonContent || '';

        if (this._deferred && !this._deferred.promise().isResolved()) {
          this._deferred.reject('New request');
        }
        var deferred = (this._deferred = vow.defer());
        var self = this;

        ymaps.route([start, finish]).then(function (router) {
          if (deferred.promise().isRejected()) return;

          // remove previous route
          if (self._route) {
            try { self._map.geoObjects.remove(self._route); } catch(e) {}
            self._route = null;
          }

          self._router = router;

          var lengthMeters = router.getLength();
          var distanceText = ymaps.formatter.distance(lengthMeters);
          var kmRounded = Math.round(lengthMeters / 1000);
          var price = self.calculate(kmRounded);
          var seconds = getDurationSeconds(router, lengthMeters);

          // draw route
          self._route = router.getPaths();
          self._route.options.set({ strokeWidth: 5, strokeColor: '0000ffff', opacity: 0.5 });
          self._map.geoObjects.add(self._route);

          // balloons
          var msg = '<span>Distance: ' + distanceText + '.</span><br/>' +
                    '<span style="font-weight: bold; font-style: italic">Cost of delivery: ' + fmtMoney(price) + ' ₾</span>';
          try {
            self._startPoint.properties.set('balloonContentBody', startBalloon + msg);
            self._finishPoint.properties.set('balloonContentBody', finishBalloon + msg);
          } catch(e) {}

          // panel
          updatePanel(distanceText, seconds, price);

          // fit bounds
          try { self._map.setBounds(self._route.getBounds(), {checkZoomRange: true}); } catch(e) {}

          // open finish balloon (optional)
          try { self._finishPoint.balloon.open().then(function(){ self._finishPoint.balloon.autoPan(); }); } catch(e) {}

          deferred.resolve();
        }, function(){
          try {
            self._finishPoint.properties.set('balloonContentBody', "Can't build route");
            self._finishPoint.balloon.open(); self._finishPoint.balloon.autoPan();
          } catch(e) {}
        });
      },

      calculate: function (lenKm) {
        return priceForKm(lenKm);
      },

      _onClick: function (event) {
        var pos = event.get('coords');
        if (!this._startPoint) this.setPoint('start', pos);
        else if (!this._finishPoint) this.setPoint('finish', pos);
        else this.setPoint('finish', pos);
      }
    });

    provide(DeliveryCalculator);
  }
);
