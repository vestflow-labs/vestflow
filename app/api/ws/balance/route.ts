import crypto from "crypto";

export const runtime = "nodejs";

const connectionLimit = 100;
const activeConnections = new Map<string, number>();

function getConnectionCount(key: string): number {
  return activeConnections.get(key) ?? 0;
}

function incrementConnection(key: string): boolean {
  const count = getConnectionCount(key);
  if (count >= connectionLimit) {
    return false;
  }
  activeConnections.set(key, count + 1);
  return true;
}

function decrementConnection(key: string): void {
  const count = getConnectionCount(key);
  if (count > 0) {
    activeConnections.set(key, count - 1);
  }
}

function computeAccept(key: string): string {
  const sha1 = crypto.createHash("sha1");
  sha1.update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
  return sha1.digest("base64");
}

function sendWebSocketFrame(
  socket: any,
  data: string,
  opcode: number = 0x81
): void {
  const payload = Buffer.from(data);
  const length = payload.length;

  let frameLength = 2 + length;
  if (length > 125) frameLength += 2;
  if (length > 65535) frameLength += 6;

  const frame = Buffer.alloc(frameLength);
  let offset = 0;

  frame[offset++] = opcode;

  if (length <= 125) {
    frame[offset++] = length;
  } else if (length <= 65535) {
    frame[offset++] = 126;
    frame.writeUInt16BE(length, offset);
    offset += 2;
  } else {
    frame[offset++] = 127;
    frame.writeBigUInt64BE(BigInt(length), offset);
    offset += 8;
  }

  payload.copy(frame, offset);
  socket.write(frame);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const account = url.searchParams.get("account");
  const token = url.searchParams.get("token");

  if (!account || !token) {
    return new Response(
      JSON.stringify({
        error: "Both account and token parameters are required",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const wsKey = request.headers.get("sec-websocket-key");
  if (!wsKey) {
    return new Response(
      JSON.stringify({
        error: "WebSocket key missing",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const connectionKey = `${account}:${token}`;
  if (!incrementConnection(connectionKey)) {
    return new Response(
      JSON.stringify({
        error: "Connection limit exceeded",
      }),
      {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const socket = (request as any).socket;
  const accept = computeAccept(wsKey);

  try {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      "\r\n"
    );

    const interval = setInterval(() => {
      const update = JSON.stringify({
        type: "balance_update",
        account,
        token,
        estimated_balance: "0",
        updated_at: Math.floor(Date.now() / 1000),
      });

      try {
        sendWebSocketFrame(socket, update);
      } catch (e) {
        clearInterval(interval);
        decrementConnection(connectionKey);
      }
    }, 5000);

    const closeHandler = () => {
      clearInterval(interval);
      decrementConnection(connectionKey);
    };

    socket.on("close", closeHandler);
    socket.on("error", closeHandler);
  } catch (error) {
    console.error("WebSocket error:", error);
    decrementConnection(connectionKey);
  }

  return new Response(null, { status: 101 });
}
