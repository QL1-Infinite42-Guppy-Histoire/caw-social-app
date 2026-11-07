(function () {
  // Remember the language choice for the gate page.
  document.querySelectorAll('.langs a').forEach(function (a) {
    a.addEventListener('click', function () {
      try { localStorage.setItem('caw-app-lang', a.getAttribute('href') === 'ja.html' ? 'ja' : 'en'); } catch (e) {}
    });
  });

  // Show the latest version + file size from GitHub. If that fails,
  // the static text already on the page stays as-is.
  var meta = document.getElementById('dlMeta');
  if (!meta) return;
  var ja = document.documentElement.lang === 'ja';
  fetch('https://api.github.com/repos/QL1-Infinite42-Guppy-Histoire/caw-social-app/releases/latest', {
    headers: { 'Accept': 'application/vnd.github+json' }
  }).then(function (res) {
    if (!res.ok) throw new Error('api ' + res.status);
    return res.json();
  }).then(function (rel) {
    var asset = (rel.assets || []).filter(function (a) { return a.name === 'caw-social.apk'; })[0];
    if (!rel.tag_name || !asset) return;
    var mb = (asset.size / 1048576).toFixed(1);
    meta.textContent = ja
      ? '最新版 ' + rel.tag_name + ' · ' + mb + ' MB · Android'
      : 'Latest version ' + rel.tag_name + ' · ' + mb + ' MB · Android';
  }).catch(function () { /* keep the static fallback text */ });
})();
