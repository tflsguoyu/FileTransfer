const CHUNK_SIZE = 64 * 1024;
const SIGNALING_KEY = "filetransfer.signalingUrl";

let mode = "send";
let selectedFiles = [];
let socket;
let peer;
let channel;
let roomCode;
let deferredInstallPrompt;
let receiveState = null;
let transferStartedAt = 0;
let transferredBytes = 0;

const els = {
  installButton: document.querySelector("#installButton"),
  statusText: document.querySelector("#statusText"),
  routePill: document.querySelector("#routePill"),
  sendTab: document.querySelector("#sendTab"),
  receiveTab: document.querySelector("#receiveTab"),
  sendPanel: document.querySelector("#sendPanel"),
  receivePanel: document.querySelector("#receivePanel"),
  dropzone: document.querySelector("#dropzone"),
  fileInput: document.querySelector("#fileInput"),
  fileList: document.querySelector("#fileList"),
  createRoomButton: document.querySelector("#createRoomButton"),
  sendCodeBox: document.querySelector("#sendCodeBox"),
  roomCode: document.querySelector("#roomCode"),
  joinCodeInput: document.querySelector("#joinCodeInput"),
  joinRoomButton: document.querySelector("#joinRoomButton"),
  transferPanel: document.querySelector("#transferPanel"),
  transferName: document.querySelector("#transferName"),
  speedText: document.querySelector("#speedText"),
  progressBar: document.querySelector("#progressBar"),
  progressText: document.querySelector("#progressText"),
  receivedList: document.querySelector("#receivedList"),
  signalingUrlInput: document.querySelector("#signalingUrlInput"),
  saveSettingsButton: document.querySelector("#saveSettingsButton"),
};

init();

function init() {
  els.signalingUrlInput.value = localStorage.getItem(SIGNALING_KEY) || "";
  bindUi();
  registerServiceWorker();
}

function bindUi() {
  els.sendTab.addEventListener("click", () => setMode("send"));
  els.receiveTab.addEventListener("click", () => setMode("receive"));
  els.fileInput.addEventListener("change", () => setFiles([...els.fileInput.files]));
  els.createRoomButton.addEventListener("click", createRoom);
  els.joinRoomButton.addEventListener("click", joinRoom);
  els.saveSettingsButton.addEventListener("click", saveSettings);

  ["dragenter", "dragover"].forEach((eventName) => {
    els.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropzone.classList.add("dragging");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    els.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropzone.classList.remove("dragging");
    });
  });

  els.dropzone.addEventListener("drop", (event) => {
    setFiles([...event.dataTransfer.files]);
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    els.installButton.hidden = false;
  });

  els.installButton.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    els.installButton.hidden = true;
  });
}

function setMode(nextMode) {
  mode = nextMode;
  const isSend = mode === "send";
  els.sendTab.classList.toggle("active", isSend);
  els.receiveTab.classList.toggle("active", !isSend);
  els.sendTab.setAttribute("aria-selected", String(isSend));
  els.receiveTab.setAttribute("aria-selected", String(!isSend));
  els.sendPanel.classList.toggle("active", isSend);
  els.receivePanel.classList.toggle("active", !isSend);
}

function setFiles(files) {
  selectedFiles = files;
  els.createRoomButton.disabled = selectedFiles.length === 0;
  els.fileList.innerHTML = "";

  for (const file of selectedFiles) {
    const row = document.createElement("div");
    row.className = "file-row";
    row.innerHTML = `<div><strong></strong><span></span></div>`;
    row.querySelector("strong").textContent = file.name;
    row.querySelector("span").textContent = formatBytes(file.size);
    els.fileList.append(row);
  }
}

function saveSettings() {
  const value = els.signalingUrlInput.value.trim().replace(/\/$/, "");
  localStorage.setItem(SIGNALING_KEY, value);
  setStatus("信令地址已保存", "未连接");
}

async function createRoom() {
  if (!selectedFiles.length) return;
  await preparePeer("send");
  connectSignaling({ role: "sender" });
}

async function joinRoom() {
  const code = els.joinCodeInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    setStatus("请输入 6 位短码", "未连接", "bad");
    return;
  }
  roomCode = code;
  await preparePeer("receive");
  connectSignaling({ role: "receiver", code });
}

async function preparePeer(role) {
  closeSession();
  setStatus("准备局域网连接", "连接中");
  peer = new RTCPeerConnection({ iceServers: [] });

  peer.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      sendSignal({ type: "candidate", candidate: event.candidate });
    }
  });

  peer.addEventListener("connectionstatechange", async () => {
    if (peer.connectionState === "connected") {
      const localOnly = await verifyLocalCandidate();
      setStatus(localOnly ? "局域网直连已建立" : "连接已建立，等待校验", localOnly ? "局域网直连" : "已连接", localOnly ? "good" : "");
    }
    if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
      setStatus("连接已断开", "未连接", "bad");
    }
  });

  if (role === "send") {
    channel = peer.createDataChannel("files", { ordered: true });
    setupChannel();
  } else {
    peer.addEventListener("datachannel", (event) => {
      channel = event.channel;
      setupChannel();
    });
  }
}

function connectSignaling({ role, code }) {
  const base = getSignalingUrl();
  if (!base) {
    setStatus("请先填写 Cloudflare Worker URL", "未连接", "bad");
    return;
  }

  const url = new URL("/connect", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("role", role);
  if (code) url.searchParams.set("code", code);

  socket = new WebSocket(url);
  socket.addEventListener("open", () => setStatus("等待对方加入", "配对中"));
  socket.addEventListener("message", handleSignal);
  socket.addEventListener("close", () => {
    if (!peer || peer.connectionState !== "connected") setStatus("信令已断开", "未连接", "bad");
  });
  socket.addEventListener("error", () => setStatus("信令连接失败", "未连接", "bad"));
}

async function handleSignal(event) {
  const message = JSON.parse(event.data);

  if (message.type === "room") {
    roomCode = message.code;
    els.roomCode.textContent = roomCode;
    els.sendCodeBox.hidden = false;
    setStatus("短码已生成，等待接收端", "配对中");
    return;
  }

  if (message.type === "peer-joined" && mode === "send") {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    sendSignal({ type: "offer", description: peer.localDescription });
    setStatus("正在建立浏览器直连", "连接中");
    return;
  }

  if (message.type === "offer") {
    await peer.setRemoteDescription(message.description);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    sendSignal({ type: "answer", description: peer.localDescription });
    setStatus("正在回应连接", "连接中");
    return;
  }

  if (message.type === "answer") {
    await peer.setRemoteDescription(message.description);
    return;
  }

  if (message.type === "candidate" && message.candidate) {
    await peer.addIceCandidate(message.candidate);
  }

  if (message.type === "error") {
    setStatus(message.message || "配对失败", "未连接", "bad");
  }
}

function sendSignal(payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function setupChannel() {
  channel.binaryType = "arraybuffer";
  channel.addEventListener("open", () => {
    setStatus(mode === "send" ? "已连接，开始发送" : "已连接，等待文件", "局域网直连", "good");
    if (mode === "send") sendFiles();
  });
  channel.addEventListener("message", handleDataMessage);
}

async function sendFiles() {
  for (const file of selectedFiles) {
    resetProgress(file.name, file.size);
    sendJson({ kind: "meta", name: file.name, size: file.size, type: file.type });

    let offset = 0;
    while (offset < file.size) {
      const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
      await waitForBuffer();
      channel.send(chunk);
      offset += chunk.byteLength;
      updateProgress(offset, file.size);
    }
    sendJson({ kind: "done" });
  }
  setStatus("全部文件已发送", "完成", "good");
}

function handleDataMessage(event) {
  if (typeof event.data === "string") {
    const payload = JSON.parse(event.data);
    if (payload.kind === "meta") {
      receiveState = {
        name: payload.name,
        size: payload.size,
        type: payload.type || "application/octet-stream",
        chunks: [],
        received: 0,
      };
      resetProgress(payload.name, payload.size);
    }
    if (payload.kind === "done" && receiveState) {
      saveReceivedFile();
    }
    return;
  }

  if (!receiveState) return;
  receiveState.chunks.push(event.data);
  receiveState.received += event.data.byteLength;
  updateProgress(receiveState.received, receiveState.size);
}

function sendJson(payload) {
  channel.send(JSON.stringify(payload));
}

function saveReceivedFile() {
  const blob = new Blob(receiveState.chunks, { type: receiveState.type });
  const url = URL.createObjectURL(blob);
  const row = document.createElement("a");
  row.className = "file-row";
  row.href = url;
  row.download = receiveState.name;
  row.innerHTML = `<div><strong></strong><span></span></div><span>下载</span>`;
  row.querySelector("strong").textContent = receiveState.name;
  row.querySelector("span").textContent = formatBytes(blob.size);
  els.receivedList.prepend(row);
  setStatus("文件已收到", "完成", "good");
  receiveState = null;
}

function waitForBuffer() {
  if (channel.bufferedAmount < CHUNK_SIZE * 16) return Promise.resolve();
  return new Promise((resolve) => {
    channel.bufferedAmountLowThreshold = CHUNK_SIZE * 8;
    channel.addEventListener("bufferedamountlow", resolve, { once: true });
  });
}

function resetProgress(name, size) {
  els.transferPanel.hidden = false;
  els.transferName.textContent = name;
  els.progressBar.style.width = "0%";
  els.progressText.textContent = `0% · ${formatBytes(size)}`;
  els.speedText.textContent = "0 MB/s";
  transferStartedAt = performance.now();
  transferredBytes = 0;
}

function updateProgress(done, total) {
  transferredBytes = done;
  const ratio = total ? done / total : 0;
  const elapsedSeconds = Math.max((performance.now() - transferStartedAt) / 1000, 0.2);
  const speed = transferredBytes / elapsedSeconds;
  els.progressBar.style.width = `${Math.min(ratio * 100, 100)}%`;
  els.progressText.textContent = `${Math.round(ratio * 100)}% · ${formatBytes(done)} / ${formatBytes(total)}`;
  els.speedText.textContent = `${formatBytes(speed)}/s`;
}

async function verifyLocalCandidate() {
  const stats = await peer.getStats();
  let selectedPair;
  for (const report of stats.values()) {
    if (report.type === "transport" && report.selectedCandidatePairId) {
      selectedPair = stats.get(report.selectedCandidatePairId);
    }
    if (report.type === "candidate-pair" && report.selected) {
      selectedPair = report;
    }
  }
  if (!selectedPair) return false;

  const local = stats.get(selectedPair.localCandidateId);
  const remote = stats.get(selectedPair.remoteCandidateId);
  return local?.candidateType === "host" && remote?.candidateType === "host";
}

function closeSession() {
  socket?.close();
  channel?.close();
  peer?.close();
  socket = null;
  channel = null;
  peer = null;
}

function getSignalingUrl() {
  return (localStorage.getItem(SIGNALING_KEY) || els.signalingUrlInput.value || "").trim().replace(/\/$/, "");
}

function setStatus(text, pill, pillClass = "") {
  els.statusText.textContent = text;
  els.routePill.textContent = pill;
  els.routePill.className = `pill ${pillClass}`.trim();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

async function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    await navigator.serviceWorker.register("./service-worker.js");
  }
}
