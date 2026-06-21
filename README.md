# FileTransfer

一个面向手机和电脑的局域网文件传输 PWA。前端可部署到 GitHub Pages，Cloudflare Worker 只负责短码信令，文件通过 WebRTC DataChannel 在浏览器之间传输。

## 设计边界

- 文件不上传到服务器。
- 不配置 TURN 中继。
- WebRTC 使用空 `iceServers`，优先局域网 host candidate。
- 连接建立后前端会检查 selected candidate pair 是否为 host/host。
- 如果浏览器或路由器阻止局域网 WebRTC 连接，传输会失败，不会自动改走云端文件中继。

## 部署前端到 GitHub Pages

1. 把仓库推送到 GitHub。
2. 在 GitHub 仓库进入 `Settings -> Pages`。
3. Source 选择 `Deploy from a branch`。
4. Branch 选择 `main`，目录选择 `/root`。
5. 打开 GitHub Pages 给出的地址。

## 部署 Cloudflare Worker

1. 安装并登录 Wrangler。
2. 在仓库根目录运行：

```sh
npx wrangler deploy
```

3. 复制部署后得到的 Worker 地址，例如：

```text
https://filetransfer-signaling.your-name.workers.dev
```

4. 打开 PWA，在“信令地址”里填入这个地址并保存。

## 使用方式

1. 两台设备连接同一个路由器。
2. 两台设备打开 PWA。
3. 发送端选择文件并生成 6 位短码。
4. 接收端输入短码加入。
5. 连接成功后文件开始传输。

## 开发预览

这个项目没有构建步骤，直接用静态服务器打开即可：

```sh
python3 -m http.server 4178
```

然后访问：

```text
http://localhost:4178
```
