# CineVault · Alloha ad-list test

Experimental Chromium extension for one observed Alloha ad-list endpoint. It returns
`{"geoUser":"","list":[]}` for `POST https://pc.alloviewroll.com/lists.php`
inside Alloha frames on `*.stravers.live`. It does not block media URLs or alter CineVault.

This is a local browser experiment, not a server-side feature and not a guarantee
that Alloha will remain ad-free. It cannot remove ads already embedded into video,
and the provider may change its request format. If playback, voice selection, or
seeking stops working, turn off the extension and reload the page.

Local verification on 2026-10-09 used an isolated Chromium profile: the exact
ad-list POST returned HTTP 200 with an empty list, unrelated XHR kept its native
response, and the main video started for both Interstellar and Dexter without
a visible ad. A live ad-list request was not observed during those two starts,
so this is not proof that every future ad placement is suppressed. Dexter's
next-episode control changed the episode, but its subsequent media manifest
timed out; that part of the flow is not verified as working.

## Install in a Chromium browser

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this directory.
4. Reload the CineVault tab before testing Alloha.

Disable or remove it from the same extensions page; reload the CineVault tab
again to restore normal requests. No tokens, cookies, or browsing data are saved
or sent by the extension. It affects Alloha frames in this browser only, even
when they are opened outside CineVault.
