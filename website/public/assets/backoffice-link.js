(function () {
  var host = (window.location.hostname || "").toLowerCase();
  var backofficeUrl = "https://backoffice.recibox.com.ar/";

  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.endsWith(".local")
  ) {
    backofficeUrl = "http://localhost:8080/";
  } else if (host.indexOf("test") !== -1 || host.indexOf("staging") !== -1 || host.indexOf("qa") !== -1) {
    backofficeUrl = "https://backoffice-test.recibox.com.ar/";
  }

  var links = document.querySelectorAll("a[data-backoffice-link]");
  for (var i = 0; i < links.length; i += 1) {
    links[i].setAttribute("href", backofficeUrl);
  }
})();
