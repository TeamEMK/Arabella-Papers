/* ══════════════════════════════════════════════════════
 * SENDING A FILE WITHOUT SENDING IT THROUGH US
 *
 * Every design file box on this app used to post its file to our own server,
 * and our own server is on a platform that refuses a request body over
 * 4.5MB. Print-ready artwork is routinely ten times that. The box looked like
 * it worked and could not have worked.
 *
 * Three steps instead. We ask our server to open an upload, the browser PUTs
 * the bytes straight to the address it gets back, and then it tells our
 * server the id. Only the first and third touch us, and both are a few
 * hundred bytes. What a form then carries is a TOKEN, not a URL - a URL in a
 * form field is a URL anybody can type.
 *
 * XMLHttpRequest rather than fetch, for the one thing fetch still cannot do:
 * say how far a fifty-megabyte upload has got.
 * ══════════════════════════════════════════════════════ */
(function (w) {
  'use strict';

  function putToDrive(url, file, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch (e) { reject(new Error('Drive finished but said something unexpected.')); }
        } else {
          reject(new Error('Drive refused the upload (' + xhr.status + ').'));
        }
      };
      // There is no status code on a CORS refusal or a dropped connection,
      // so there is nothing to report but the fact of it.
      xhr.onerror = function () {
        reject(new Error('The upload could not reach Drive. Check the connection and try again.'));
      };
      xhr.onabort = function () { reject(new Error('The upload was stopped.')); };
      xhr.send(file);
    });
  }

  function jsonPost(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }

  /**
   * Put one file in Drive and come back with the token a form should carry.
   * `say` is optional and is called with a line of progress.
   * @returns {Promise<{token: string, url: string, name: string}>}
   */
  function send(file, say) {
    var note = say || function () {};
    note('Preparing ' + file.name + '...');
    return jsonPost('/api/uploads/session', {
      fileName: file.name, mimeType: file.type, size: file.size,
    }).then(function (opened) {
      if (!opened.success) throw new Error(opened.error || 'The upload could not be started.');
      var mb = (file.size / 1048576).toFixed(1);
      return putToDrive(opened.sessionUrl, file, function (done) {
        note('Uploading ' + file.name + ' — ' + Math.round(done * 100) + '% of ' + mb + ' MB');
      }).then(function (drive) {
        note('Finishing ' + file.name + '...');
        return jsonPost('/api/uploads/claim', { token: opened.token, fileId: drive.id });
      }).then(function (filed) {
        if (!filed.success) throw new Error(filed.error || 'The upload could not be filed.');
        return { token: opened.token, url: filed.url, name: filed.name };
      });
    });
  }

  /**
   * The same for a whole file list, one after another rather than all at
   * once: ten parallel uploads on an office line finish later than ten in a
   * row and report their progress over the top of each other.
   * @returns {Promise<Array<{token, url, name}>>}
   */
  function sendAll(files, say) {
    var list = Array.prototype.slice.call(files || []);
    var out = [];
    return list.reduce(function (chain, f, i) {
      return chain.then(function () {
        return send(f, function (line) {
          say && say(list.length > 1 ? '(' + (i + 1) + ' of ' + list.length + ') ' + line : line);
        }).then(function (r) { out.push(r); });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  w.ArabellaUpload = { send: send, sendAll: sendAll };
}(window));
