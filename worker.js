export class Room {
  constructor(state) {
    this.state = state;
    this.clients = new Map();
  }

  async fetch(request) {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    const code = url.searchParams.get("code") || this.state.id.name;

    if (!["sender", "receiver"].includes(role)) {
      return new Response("Invalid role", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.connect(server, role, code);
    return new Response(null, { status: 101, webSocket: client });
  }

  connect(socket, role, code) {
    socket.accept();
    this.clients.set(role, socket);
    socket.send(JSON.stringify({ type: "room", code }));

    if (this.clients.has("sender") && this.clients.has("receiver")) {
      this.sendTo("sender", { type: "peer-joined" });
      this.sendTo("receiver", { type: "peer-joined" });
    }

    socket.addEventListener("message", (event) => {
      const target = role === "sender" ? "receiver" : "sender";
      this.sendTo(target, JSON.parse(event.data));
    });

    socket.addEventListener("close", () => this.clients.delete(role));
    socket.addEventListener("error", () => this.clients.delete(role));
  }

  sendTo(role, payload) {
    const target = this.clients.get(role);
    if (target?.readyState === WebSocket.OPEN) {
      target.send(JSON.stringify(payload));
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (url.pathname !== "/connect") {
      return withCors(new Response("FileTransfer signaling worker", { status: 200 }));
    }

    const role = url.searchParams.get("role");
    const providedCode = url.searchParams.get("code");
    const code = role === "sender" ? createCode() : providedCode;

    if (!/^\d{6}$/.test(code || "")) {
      return withCors(new Response("Invalid room code", { status: 400 }));
    }

    url.searchParams.set("code", code);
    const roomRequest = new Request(url, request);
    const roomId = env.ROOMS.idFromName(code);
    const room = env.ROOMS.get(roomId);
    return room.fetch(roomRequest);
  },
};

function createCode() {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(value).padStart(6, "0");
}

function withCors(response) {
  const next = new Response(response.body, response);
  next.headers.set("Access-Control-Allow-Origin", "*");
  next.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  next.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return next;
}
