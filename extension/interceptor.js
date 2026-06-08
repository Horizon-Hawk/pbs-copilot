// Injected into NavBlue main world — intercepts fetch/XHR before AngularJS runs
(function () {
  if (window.__pbsInterceptorActive) return;
  window.__pbsInterceptorActive = true;

  function relay(url, text) {
    if (!text || text.length < 50) return;
    const isStatic = /\.(html|js|css|png|woff2?|svg|ico)(\?|$)/.test(url);
    if (!isStatic) {
      window.postMessage({ type: '__PBS_DATA_CALL__', url: url.slice(0, 300), size: text.length, preview: text.slice(0, 120) }, '*');
    }
    // XML pairings
    if (text.includes('<Pairing')) {
      window.postMessage({ type: '__PBS_PAIRINGS__', url, data: text, format: 'xml' }, '*');
      return;
    }
    // JSON pairings — NavBlue uses str-prefixed keys (strPairingNumber, strCheckinTime, etc.)
    if (text.includes('"strPairingNumber"')) {
      window.postMessage({ type: '__PBS_PAIRINGS__', url, data: text, format: 'json' }, '*');
    }
  }

  // Intercept fetch — no URL filter, catches all same-origin requests
  const _fetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    return _fetch(input, init).then(function (res) {
      res.clone().text().then(function (t) { relay(url, t); }).catch(function(){});
      return res;
    });
  };

  // Intercept XHR — no URL filter
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this._pbsUrl = url || '';
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    xhr.addEventListener('load', function () {
      let text = '';
      try {
        if (!xhr.responseType || xhr.responseType === 'text') {
          text = xhr.responseText;
        } else if (xhr.responseType === 'json') {
          text = JSON.stringify(xhr.response);
        } else {
          return; // arraybuffer/blob/document — skip
        }
      } catch (e) { return; }
      relay(xhr._pbsUrl || '', text);
    });
    return _send.apply(this, arguments);
  };

  console.log('[PBS] interceptor active');
})();
