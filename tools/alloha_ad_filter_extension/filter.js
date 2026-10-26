(() => {
  "use strict";

  // WKWebView injects user scripts into every frame; Chrome already restricts
  // this file through manifest matches. Keep the same provider-only scope.
  // Alloha moves between subdomains (theatre., loosening-as., …) of the same host.
  if (!/(^|\.)stravers\.live$/.test(location.hostname)) return;

  // Scope this experiment to the one JSON ad-list request observed in Alloha.
  // In particular, never intercept video manifests, segments, or other ads APIs.
  const AD_LIST_ORIGIN = "https://pc.alloviewroll.com";
  const AD_LIST_PATH = "/lists.php";
  const EMPTY_LIST_TEXT = JSON.stringify({ geoUser: "", list: [] });
  const CONTENT_TYPE = "application/json; charset=utf-8";
  const NativeXHR = window.XMLHttpRequest;
  const nativeFetch = window.fetch;
  const states = new WeakMap();
  const overriddenProperties = [
    "readyState", "status", "statusText", "response", "responseText",
    "responseURL", "responseType", "responseXML",
  ];

  if (!NativeXHR || !nativeFetch) return;

  function isAdList(method, rawUrl) {
    if (String(method).toUpperCase() !== "POST") return false;
    try {
      const url = new URL(String(rawUrl), document.baseURI);
      return url.origin === AD_LIST_ORIGIN && url.pathname === AD_LIST_PATH;
    } catch {
      return false;
    }
  }

  function emit(xhr, type) {
    xhr.dispatchEvent(new ProgressEvent(type));
  }

  function restoreNativeProperties(xhr) {
    for (const name of overriddenProperties) delete xhr[name];
  }

  function installResponseProperties(xhr, state) {
    Object.defineProperties(xhr, {
      readyState: { configurable: true, get: () => state.readyState },
      status: { configurable: true, get: () => state.status },
      statusText: { configurable: true, get: () => state.statusText },
      responseURL: { configurable: true, get: () => state.url },
      responseType: {
        configurable: true,
        get: () => state.responseType,
        set: (value) => { state.responseType = String(value); },
      },
      responseText: { configurable: true, get: () => state.body },
      response: {
        configurable: true,
        get: () => state.responseType === "json"
          ? { geoUser: "", list: [] }
          : state.body,
      },
      responseXML: { configurable: true, get: () => null },
    });
  }

  const open = NativeXHR.prototype.open;
  const send = NativeXHR.prototype.send;
  const abort = NativeXHR.prototype.abort;
  const setRequestHeader = NativeXHR.prototype.setRequestHeader;
  const getResponseHeader = NativeXHR.prototype.getResponseHeader;
  const getAllResponseHeaders = NativeXHR.prototype.getAllResponseHeaders;
  const overrideMimeType = NativeXHR.prototype.overrideMimeType;

  NativeXHR.prototype.open = function (method, url, async = true, ...rest) {
    const previous = states.get(this);
    if (previous) {
      previous.aborted = true;
      states.delete(this);
      restoreNativeProperties(this);
    }
    if (!isAdList(method, url)) return open.call(this, method, url, async, ...rest);

    const state = {
      url: new URL(String(url), document.baseURI).href,
      async: async !== false,
      readyState: NativeXHR.OPENED,
      status: 0,
      statusText: "",
      responseType: "",
      body: "",
      sent: false,
      aborted: false,
    };
    states.set(this, state);
    installResponseProperties(this, state);
    emit(this, "readystatechange");
  };

  NativeXHR.prototype.send = function (body) {
    const state = states.get(this);
    if (!state) return send.call(this, body);
    if (state.sent) throw new DOMException("Request already sent", "InvalidStateError");
    state.sent = true;
    emit(this, "loadstart");

    const complete = () => {
      if (state.aborted || states.get(this) !== state) return;
      state.status = 200;
      state.statusText = "OK";
      state.readyState = NativeXHR.HEADERS_RECEIVED;
      emit(this, "readystatechange");
      state.readyState = NativeXHR.LOADING;
      emit(this, "readystatechange");
      state.body = EMPTY_LIST_TEXT;
      state.readyState = NativeXHR.DONE;
      emit(this, "readystatechange");
      emit(this, "load");
      emit(this, "loadend");
    };

    if (state.async) setTimeout(complete, 0);
    else complete();
  };

  NativeXHR.prototype.abort = function () {
    const state = states.get(this);
    if (!state) return abort.call(this);
    if (state.aborted || state.readyState === NativeXHR.DONE) return;
    state.aborted = true;
    state.readyState = NativeXHR.UNSENT;
    emit(this, "readystatechange");
    emit(this, "abort");
    emit(this, "loadend");
  };

  NativeXHR.prototype.setRequestHeader = function (...args) {
    if (states.has(this)) return;
    return setRequestHeader.apply(this, args);
  };

  NativeXHR.prototype.getResponseHeader = function (name) {
    const state = states.get(this);
    if (!state) return getResponseHeader.call(this, name);
    if (state.readyState < NativeXHR.HEADERS_RECEIVED) return null;
    return String(name).toLowerCase() === "content-type" ? CONTENT_TYPE : null;
  };

  NativeXHR.prototype.getAllResponseHeaders = function () {
    const state = states.get(this);
    if (!state) return getAllResponseHeaders.call(this);
    return state.readyState < NativeXHR.HEADERS_RECEIVED
      ? ""
      : `content-type: ${CONTENT_TYPE}\r\n`;
  };

  NativeXHR.prototype.overrideMimeType = function (...args) {
    if (states.has(this)) return;
    return overrideMimeType.apply(this, args);
  };

  window.fetch = function (input, init) {
    const url = typeof input === "string" || input instanceof URL ? input : input?.url;
    const method = init?.method || (typeof input === "object" && input?.method) || "GET";
    if (isAdList(method, url)) {
      return Promise.resolve(new Response(EMPTY_LIST_TEXT, {
        status: 200,
        headers: { "content-type": CONTENT_TYPE },
      }));
    }
    return nativeFetch.apply(this, arguments);
  };
})();
