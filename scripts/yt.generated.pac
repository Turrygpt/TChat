// TChat — сгенерировано автоматически. Только YouTube -> прокси, остальное DIRECT.
function FindProxyForURL(url, host) {
  var PROXY = "PROXY 127.0.0.1:10810";
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
    is("youtubei.googleapis.com")
  ) {
    return PROXY;
  }
  return "DIRECT";
}
