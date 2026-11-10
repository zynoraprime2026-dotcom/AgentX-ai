// The dashboard has to install as a real app on a laptop: a manifest the browser accepts,
// an offline shell that never serves stale API data, and a button that tells the truth on
// browsers that cannot install.
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, String(x).slice(0, 200)); } };
const magic = JSON.parse(fs.readFileSync(__dirname + '/public/manifest.webmanifest', 'utf8'));
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
const js = fs.readFileSync(__dirname + '/public/app.js', 'utf8');
const sw = fs.readFileSync(__dirname + '/public/sw.js', 'utf8');

ok('manifest is linked from the page', /rel="manifest" href="manifest\.webmanifest"/.test(html));
ok('manifest has an id and scope', magic.id === '/' && magic.scope === '/');
ok('manifest installs standalone', magic.display === 'standalone');
ok('manifest has a maskable icon', (magic.icons || []).some((i) => String(i.purpose || '').includes('maskable')));
ok('manifest has a real png icon', (magic.icons || []).some((i) => /png$/.test(i.type) && /1024x1024/.test(i.sizes)));
ok('manifest shortcuts open the views that exist', (magic.shortcuts || []).every((s) => html.includes('id="view-' + s.url.split('view=')[1] + '"')));
ok('theme colour is declared', /name="theme-color"/.test(html));
ok('an install button exists and starts hidden', /id="installApp"[^>]*display:none/.test(html));
ok('the button is shown only when the browser offers an install prompt', /beforeinstallprompt[\s\S]{0,200}installEvent = e;[\s\S]{0,80}btn\.style\.display = ''/.test(js));
ok('installing hides the button', /appinstalled[\s\S]{0,200}btn\.style\.display = 'none'/.test(js));
ok('a declined prompt stays recoverable', /Try installing again/.test(js));
ok('Firefox gets the truth, not a fake prompt', /Firefox on a laptop cannot install web apps/.test(js));
ok('Safari gets the Add to Dock step', /Share, then Add to Dock/.test(js));
ok('the service worker is registered at the root scope', /register\('\/sw\.js'\)/.test(js));

ok('the shell is versioned', /agentx-shell-v1/.test(sw));
ok('the shell precaches the page and its code', /\['\/', '\/app\.js', '\/style\.css'/.test(sw));
ok('api requests never fall back to a cached answer', /pathname\.startsWith\('\/api\/'\)[\s\S]{0,220}fetch\(req\)\.catch/.test(sw));
ok('an offline api call answers 503 instead of a stale 200', /status: 503/.test(sw));
ok('navigations fall back to the stored shell', /req\.mode === 'navigate'[\s\S]{0,400}caches\.match\('\/'\)/.test(sw));
ok('old caches are cleared on activate', /keys\.filter\(\(k\) => k !== SHELL\)/.test(sw));
ok('non-GET and cross-origin requests are left alone', /req\.method !== 'GET'[\s\S]{0,120}return;/.test(sw) && /url\.origin !== self\.location\.origin/.test(sw));

// the install shortcut must not break a normal visit
ok('boot does not throw when the api is unavailable', /try \{ setupServiceWorker\(\); setupInstall\(\); \} catch \(e\) \{\}/.test(js));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
