// Injected into NavBlue main world — intercepts fetch/XHR before AngularJS runs
(function () {
  if (window.__pbsInterceptorActive) return;
  window.__pbsInterceptorActive = true;

  function relay(url, text) {
    if (!text || text.length < 100) return;
    // Log all non-HTML data calls so we can see what's happening
    if (!url.endsWith('.html') && !url.endsWith('.js') && !url.endsWith('.css') && !url.endsWith('.png')) {
      window.postMessage({ type: '__PBS_DATA_CALL__', url: url.slice(0, 300), size: text.length, preview: text.slice(0, 120) }, '*');
    }
    // Grab anything with pairing data
    if (text.includes('<Pairing') || text.includes('"Pairing"') || text.includes('"pairing"')) {
      window.postMessage({ type: '__PBS_PAIRINGS__', url, data: text }, '*');
    }
  }

  // Intercept fetch
  const _fetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    return _fetch(input, init).then(function (res) {
      if (url.includes('navblue.cloud') || url.includes('ClassBidUI')) {
        res.clone().text().then(function (t) { relay(url, t); }).catch(function(){});
      }
      return res;
    });
  };

  // Intercept XHR
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this._pbsUrl = url || '';
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    xhr.addEventListener('load', function () {
      const url = xhr._pbsUrl || '';
      if (url.includes('navblue.cloud') || url.includes('ClassBidUI')) {
        relay(url, xhr.responseText);
      }
    });
    return _send.apply(this, arguments);
  };

  console.log('[PBS] interceptor active');
})();
