// backend/src/realtime/socket.ts
import { Server } from "socket.io";
import type { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";

export function setupRealtime(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_URL || "http://localhost:5173",
      credentials: true,
    },
  });

  io.use((socket, next) => {
    // Accept token via auth or Authorization header
    const token =
      (socket.handshake.auth as any)?.token ||
      (socket.handshake.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return next(new Error("Unauthorized"));

    try {
      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || "your-secret-key"
      ) as { userId: string; email: string };

      (socket as any).userId = decoded.userId;
      socket.join(`user:${decoded.userId}`);
      return next();
    } catch {
      return next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    // You can add more per-connection handlers if needed
    socket.on("disconnect", () => {
      // cleanup if needed
    });
  });

  return io;
}