// TChat — маршрутизация только YouTube-трафика в локальный обход.
// Всё, что не YouTube, идёт напрямую (DIRECT).
// Прокси-эндпоинт задаётся генерацией из main.js (см. ytProxy.js); здесь — дефолт.
function FindProxyForURL(url, host) {
  var PROXY = "PROXY 127.0.0.1:1080";

  host = (host || "").toLowerCase();

  function is(suffix) {
    return host === suffix || host.slice(-(suffix.length + 1)) === ("." + suffix);
  }

  if (
    is("youtube.com") ||
    is("youtu.be") ||
    is("youtube-nocookie.com") ||
    is("googlevideo.com") ||
    is("ytimg.com") ||
    is("ggpht.com") ||
    is("youtubei.googleapis.com") ||
    is("yt3.ggpht.com") ||
    is("i.ytimg.com")
  ) {
    return PROXY;
  }

  return "DIRECT";
}
