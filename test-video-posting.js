// "Can it post videos?" has to mean the same discipline as images: posted by URL, staged,
// and only after the owner says yes.
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, String(x).slice(0, 160)); } };
const srv = fs.readFileSync(__dirname + '/server.js', 'utf8');
const soc = fs.readFileSync(__dirname + '/lib/social.js', 'utf8');
const ig = fs.readFileSync(__dirname + '/lib/instagram.js', 'utf8');

ok('a Page video upload exists', /async function uploadPageVideo/.test(soc));
ok('it posts to the videos edge', /'\/' \+ id \+ '\/videos'/.test(soc));
ok('it requires a public url', /a public video URL is required/.test(soc));
ok('it sends a plain object, not URLSearchParams', /const params = \{ file_url: url, description/.test(soc));
ok('the upload is exported', /module\.exports = \{\s*\n?\s*uploadPageVideo/.test(soc));
ok('a studio video tool exists', /name: 'make_video'/.test(srv));
ok('it calls the studio video route', /studioCall\('\/v1\/video\/from-image'/.test(srv));
ok('clip length is bounded', /Math\.min\(Math\.max\(Number\(args\.seconds\) \|\| 6, 3\), 20\)/.test(srv));
ok('posting a video is a tool', /name: 'post_video'/.test(srv));
ok('it is staged, never immediate', /kind: 'page_video'/.test(srv) && /Reply yes to publish it/.test(srv));
ok('it is owner gated', /case 'post_video'[\s\S]{0,120}Posting is the owner/.test(srv));
ok('yes uploads the video', /if \(pending\.kind === 'page_video'\)[\s\S]{0,300}uploadPageVideo/.test(srv));
ok('the staging is cleared after', /uploadPageVideo[\s\S]{0,1400}clearPendingAction/.test(srv));
ok('an instagram reel is attempted', /isReel: true/.test(srv));
ok('instagram already supports video', /media_type = isReel === false \? 'VIDEO' : 'REELS'/.test(ig));
ok('an instagram failure does not hide the facebook post', /Instagram did not take it/.test(srv));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
