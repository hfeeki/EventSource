/*jslint sloppy: true, white: true, plusplus: true, indent: 2, regexp: true */
/*global XMLHttpRequest, setTimeout, clearTimeout, XDomainRequest, ActiveXObject*/

(function (global) {

  function parseURI(url) {
    var m = String(url).replace(/^\s+|\s+$/g, '').match(/^([^:\/?#]+:)?(\/\/(?:[^:@]*(?::[^:@]*)?@)?(([^:\/?#]*)(?::(\d*))?))?([^?#]*)(\?[^#]*)?(#[\s\S]*)?/);
    // authority = '//' + user + ':' + pass '@' + hostname + ':' port
    return (m ? {
      href     : m[0] || '',
      protocol : m[1] || '',
      authority: m[2] || '',
      host     : m[3] || '',
      hostname : m[4] || '',
      port     : m[5] || '',
      pathname : m[6] || '',
      search   : m[7] || '',
      hash     : m[8] || ''
    } : null);
  }

  function absolutizeURI(base, href) {// RFC 3986

    function removeDotSegments(input) {
      var output = [];
      input.replace(/^(\.\.?(\/|$))+/, '')
           .replace(/\/(\.(\/|$))+/g, '/')
           .replace(/\/\.\.$/, '/../')
           .replace(/\/?[^\/]*/g, function (p) {
        if (p === '/..') {
          output.pop();
        } else {
          output.push(p);
        }
      });
      return output.join('').replace(/^\//, input.charAt(0) === '/' ? '/' : '');
    }

    href = parseURI(href || '');
    base = parseURI(base || '');

    return !href || !base ? null : (href.protocol || base.protocol) +
           (href.protocol || href.authority ? href.authority : base.authority) +
           removeDotSegments(href.protocol || href.authority || href.pathname.charAt(0) === '/' ? href.pathname : (href.pathname ? ((base.authority && !base.pathname ? '/' : '') + base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1) + href.pathname) : base.pathname)) +
           (href.protocol || href.authority || href.pathname ? href.search : (href.search || base.search)) +
           href.hash;
  }

  function loc() {
    try {
      return global.location.href;
    } catch (e) {
      var a = document.createElement('a');
      a.href = '';
      return a.href;
    }
  }

  // http://blogs.msdn.com/b/ieinternals/archive/2010/04/06/comet-streaming-in-internet-explorer-with-xmlhttprequest-and-xdomainrequest.aspx?PageIndex=1#comments
  // XDomainRequest does not have a binary interface. To use with non-text, first base64 to string.
  // http://cometdaily.com/2008/page/3/
  function XDomainRequestWrapper() {
    var x = new global.XDomainRequest(),
      that = this;

    that.readyState = 0;
    that.responseText = '';

    function onChange(readyState, responseText) {
      that.readyState = readyState;
      that.responseText = responseText;
      that.onreadystatechange();
    }

    x.onload = function () {
      onChange(4, x.responseText);
    };

    x.onerror = function () {
      onChange(4, '');
    };

    x.onprogress = function () {
      onChange(3, x.responseText);
    };

    that.open = function (method, url) {
      return x.open(method, url);
    };

    that.abort = function () {
      return x.abort();
    };

    that.send = function (postData) {
      return x.send(postData);
    };

    that.setRequestHeader = function () {};

    that.getResponseHeader = function (name) {
      return (/^content\-type$/i).test(name) ? x.contentType : '';
    };

    return that;
  }

  function extendAsEventTarget(obj) {
    var listeners = [];

    obj.dispatchEvent = function (eventObject) {
      var clone = listeners.slice(0),
          type = eventObject.type, i;
      for (i = 0; i < clone.length; i++) {
        if (clone[i].type === type) {
          clone[i].callback.call(obj, eventObject);
        }
      }
    };

    obj.addEventListener = function (type, callback) {
      var i = listeners.length - 1;
      while (i >= 0 && !(listeners[i].type === type && listeners[i].callback === callback)) {
        i--;
      }
      if (i === -1) {
        listeners.push({type: type, callback: callback});
      }
    };

    obj.removeEventListener = function (type, callback) {
      var i = listeners.length - 1;
      while (i >= 0 && !(listeners[i].type === type && listeners[i].callback === callback)) {
        i--;
      }
      if (i === -1) {
        listeners[i].type = {};// mark as removed
        listeners.splice(i, 1);
      }
    };

    return obj;
  }

  function empty() {};

  var XHR2CORSSupported = !!(global.XDomainRequest || (global.XMLHttpRequest && ('onprogress' in (new XMLHttpRequest())) && ('withCredentials' in (new XMLHttpRequest()))));

  // FF 6 doesn't support SSE + CORS
  if (!global.EventSource || XHR2CORSSupported) {
    global.EventSource = function (url) {
      url = absolutizeURI(loc(), String(url));
      if (!url) {
        throw new Error('');
      }

      var that = {},
        retry = 1000,
        lastEventId = '',
        xhr = null,
        reconnectTimeout = null,
        origin = parseURI(url);

      origin = origin.protocol + origin.authority;

      that.url = url;
      that.CONNECTING = 0;
      that.OPEN = 1;
      that.CLOSED = 2;
      that.readyState = that.CONNECTING;

      function dispatchEvent(event) {
        event.target = that;
        that.dispatchEvent(event);
        if (/^(message|error|open)$/.test(event.type) && typeof that['on' + event.type] === 'function') {
          that['on' + event.type](event);
        }
      }

      function close() {
        // http://dev.w3.org/html5/eventsource/ The close() method must close the connection, if any; must abort any instances of the fetch algorithm started for this EventSource object; and must set the readyState attribute to CLOSED.
        if (xhr !== null) {
          xhr.onreadystatechange = empty;
          xhr.abort();
          xhr = null;
        }
        if (reconnectTimeout !== null) {
          clearTimeout(reconnectTimeout);
          reconnectTimeout = null;
        }
        that.readyState = that.CLOSED;
        if ('\v' === 'v' && global.detachEvent) {
          global.detachEvent('onunload', close);
        }
      }

      that.close = close;

      extendAsEventTarget(that);

      // setTimeout (XDomainRequest calls onopen before returning the send() method call...) (!? when postData is null or empty string or method === 'GET' !?)
      reconnectTimeout = setTimeout(function openConnection() {
        reconnectTimeout = null;

        var postData = (lastEventId !== '' ? 'Last-Event-ID=' + encodeURIComponent(lastEventId) : ''),
            offset = 0,
            charOffset = 0,
            data = '',
            newLastEventId = lastEventId,
            name = '';

        xhr = global.XDomainRequest ? (new XDomainRequestWrapper()) : (global.XMLHttpRequest ? (new global.XMLHttpRequest()) : (new ActiveXObject('Microsoft.XMLHTTP')));

        // with GET method in FF xhr.onreadystatechange with readyState === 3 doesn't work
        xhr.open('POST', url, true);
        //xhr.setRequestHeader('Cache-Control', 'no-cache'); Chrome bug
        xhr.setRequestHeader('Content-type', 'application/x-www-form-urlencoded');

        if (!XHR2CORSSupported) {
          xhr.setRequestHeader('Polling', '1');//!
          xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
        }

        if (lastEventId !== '') {
          xhr.setRequestHeader('Last-Event-ID', lastEventId);
        }
        //xhr.withCredentials = true;

        xhr.onreadystatechange = function () {
          var readyState = +xhr.readyState,
              responseText = '', contentType = '', i = 0, line, part, stream;

          if (readyState === 3 || readyState === 4) {
            try {
              responseText = xhr.responseText || '';
            } catch (ex) {}
          }

          //use xhr.responseText instead of xhr.status (http://bugs.jquery.com/ticket/8135)
          if (that.readyState === that.CONNECTING && readyState > 1) {
            try {
              contentType = xhr.getResponseHeader('Content-Type') || '';// old FF bug ?
            } catch (ex2) {}
            if (/^text\/event\-stream/i.test(contentType) && (readyState !== 4 || responseText)) {
              that.readyState = that.OPEN;
              dispatchEvent({'type': 'open'});
            }
          }

          if (that.readyState === that.OPEN && /\r|\n/.test(responseText.slice(charOffset))) {
            part = responseText.slice(offset);
            stream = (offset ? part : part.replace(/^\uFEFF/, '')).replace(/\r\n?/g, '\n').split('\n');

            offset += part.length - stream[stream.length - 1].length;

            while (that.readyState !== that.CLOSED && i < stream.length - 1) {
              line = stream[i].match(/([^\:]*)(?:\:\u0020?([\s\S]+))?/);

              if (!line[0]) {
                // dispatch the event
                if (data) {
                  lastEventId = newLastEventId;
                  dispatchEvent({
                    'type': name || 'message',
                    origin: origin,
                    lastEventId: lastEventId,
                    data: data.replace(/\u000A$/, '')
                  });
                }
                // Set the data buffer and the event name buffer to the empty string.
                data = '';
                name = '';
              }

              if (line[1] === 'event') {
                name = line[2];
              }

              if (line[1] === 'id') {
                newLastEventId = line[2];
                //lastEventId = line[2];//!!! see bug http://www.w3.org/Bugs/Public/show_bug.cgi?id=13761
              }

              if (line[1] === 'retry') {
                if (/^\d+$/.test(line[2])) {
                  retry = +line[2];
                }
              }

              if (line[1] === 'data') {
                data += line[2] + '\n';
              }

              i++;
            }
          }
          charOffset = responseText.length;

          if (that.readyState !== that.CLOSED && readyState === 4) {
            xhr.onreadystatechange = empty;// old IE bug?
            xhr = null;
            if (that.readyState === that.OPEN) {
              that.readyState = that.CONNECTING;// reestablishes the connection
              reconnectTimeout = setTimeout(openConnection, retry);
            } else {
              close();//fail the connection
            }
            dispatchEvent({'type': 'error'});
          }
        };
        xhr.send(postData);
      }, 1);

      if ('\v' === 'v' && global.attachEvent) {
        global.attachEvent('onunload', close);
      }

      return that;
    };
  }

  global.EventSource.supportCORS = XHR2CORSSupported;

}(this));
