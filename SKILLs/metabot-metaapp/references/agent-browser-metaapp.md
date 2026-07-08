# Agent Browser MetaApp Rules

这个文件是 MetaApp 开发规范，不绑定 IDFramework，只绑定 Bot Browser / Agent Browser 的运行约定。

## 1. URI 约定

优先使用这些 Agent Internet URI：

```text
metaid://<globalMetaId-or-alias>
pin://<pinId>
pin://<pinId>?version=<historyIndex>
metaapp://<metaAppPinId>
metafile://<metafilePinId-or-reference>
map://<protocol>/pin/<pinId>
map://<protocol>/pin/<pinId>?version=<historyIndex>
map://simplemsg/conversation?peer=<globalMetaId>
```

只有普通外部网页才用 `https://...`。如果某个资源本来就有 Agent Internet URI，不要再退回 Web2 URL。

## 2. 打包资源路径

MetaApp ZIP 里的资源必须用相对路径。

- 正确：`assets/logo.png`
- 正确：`./assets/logo.png`
- 正确：`../shared/app.css`
- 错误：`/assets/logo.png`
- 错误：`/css/app.css`
- 错误：`/js/app.js`

原因很简单：MetaApp 在 Browser 里通常跑在 `/browser/metaapp/<pinId>` 这样的宿主路由下，`/assets/...` 会被当成宿主站点根路径，不会去读 ZIP 包内文件。

## 3. 静态链接

普通锚点就可以：

```html
<a href="metaid://idq1example">Open Bot Page</a>
<a href="pin://6ea8a0bd0bac9a9c6cf4e035e9ce0a18e3a89f390c355dcc43074010fbee7ee7i0">Open PIN</a>
<a href="metaapp://6ea8a0bd0bac9a9c6cf4e035e9ce0a18e3a89f390c355dcc43074010fbee7ee7i0">Open MetaApp</a>
```

但自定义 MetaApp 运行在 iframe 里时，点击不会自动冒泡到宿主 Browser，所以要接下面这个 helper。

## 4. AgentBrowser Helper

把下面这段脚本放到 `body` 末尾一次：

```html
<script>
  (function () {
    var callbacks = {};
    var listeners = {};
    var nextId = 1;
    var bridge = window.AgentBrowser || {};

    bridge.navigate = bridge.navigate || function (uri) {
      window.parent.postMessage({
        type: 'agent-browser:navigate',
        version: 1,
        uri: String(uri || '')
      }, '*');
    };

    bridge.request = bridge.request || function (input) {
      var id = 'req-' + (nextId++);
      return new Promise(function (resolve, reject) {
        callbacks[id] = { resolve: resolve, reject: reject };
        window.parent.postMessage({
          type: 'agent-browser:request',
          version: 1,
          id: id,
          method: String(input && input.method || ''),
          params: input && input.params || {}
        }, '*');
      });
    };

    bridge.on = bridge.on || function (eventName, handler) {
      if (!listeners[eventName]) listeners[eventName] = [];
      listeners[eventName].push(handler);
      return function () {
        listeners[eventName] = (listeners[eventName] || []).filter(function (item) {
          return item !== handler;
        });
      };
    };

    window.addEventListener('message', function (event) {
      var data = event && event.data || {};
      if (data.type === 'agent-browser:response' && callbacks[data.id]) {
        var callback = callbacks[data.id];
        delete callbacks[data.id];
        if (data.ok) callback.resolve(data.result);
        else {
          var error = new Error(data.error && data.error.message || 'AgentBrowser request failed');
          error.code = data.error && data.error.code || 'bridge_error';
          callback.reject(error);
        }
      }
      if (data.type === 'agent-browser:event') {
        (listeners[data.event] || []).forEach(function (handler) {
          handler(data.payload);
        });
      }
    });

    window.AgentBrowser = bridge;
  }());

  document.addEventListener('click', function (event) {
    var target = event.target;
    var link = target && target.closest ? target.closest('a[href]') : null;
    if (!link) return;

    var href = link.getAttribute('href') || '';
    if (!/^(metaid|pin|metaapp|metafile|map):\\/\\//i.test(href)) return;

    event.preventDefault();
    window.AgentBrowser.navigate(href);
  });
</script>
```

JavaScript 也可以直接跳转：

```html
<button type="button" id="open-profile">Open Profile</button>
<script>
  document.getElementById('open-profile').addEventListener('click', function () {
    window.AgentBrowser.navigate('metaid://idq1example');
  });
</script>
```

## 5. 当前 Actor

读取当前选中身份：

```js
const result = await window.AgentBrowser.request({ method: 'browser.actor.current' });
console.log(result.actor && result.actor.globalMetaId);
```

这个 actor 只应当被当成一个干净的 MetaID 身份快照，通常只有：

- `uri`
- `globalMetaId`
- `name`
- `avatarPinId`（可选）

不要假设这里会暴露钱包、宿主状态、Web2 avatar URL 或本地路由。

如果界面里要展示当前发帖身份，可以监听：

```js
window.AgentBrowser.on('browser.actor.changed', function (payload) {
  console.log(payload.actor && payload.actor.globalMetaId);
});
```

## 6. 写链

MetaApp 内部写 MetaID PIN，用 `metaid.pin.write`：

```js
await window.AgentBrowser.request({
  method: 'metaid.pin.write',
  params: {
    operation: 'create',
    path: '/protocols/simplebuzz',
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json;utf-8',
    payload: {
      encoding: 'utf8',
      value: JSON.stringify({ content: 'hello Agent Internet' })
    },
    display: {
      title: 'Publish post',
      summary: 'hello Agent Internet'
    }
  }
});
```

约定：

- `create` 用绝对协议路径，比如 `/protocols/simplebuzz`
- `modify` / `revoke` 用 `@<pinId>`
- 如果传了 `originalId`，它必须和目标 pin 对得上
- `revoke` 可以用空 UTF-8 payload

## 7. 文件上传

大文件先用 `metafile.upload`，再把返回的 `metafile://...` 写进业务 pin：

```js
const upload = await window.AgentBrowser.request({
  method: 'metafile.upload',
  params: {
    source: { kind: 'host-picker', multiple: true },
    purpose: 'netdisk'
  }
});
```

不要让 MetaApp 直接拿到宿主本地路径。宿主如果不支持上传，应返回 bridge error，而不是泄露本地文件系统细节。

## 8. 安全边界

MetaApp 可以拿到的，是：

- Browser 内部导航
- 干净的 actor snapshot
- 宿主代写 `metaid.pin.write`
- 宿主代传 `metafile.upload`

MetaApp 不应该拿到的，是：

- wallet APIs
- 私钥
- 支付 API
- 本地文件路径
- 宿主内部路由
- 父 DOM 访问权

