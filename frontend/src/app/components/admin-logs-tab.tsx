import { LogsPanel } from "./logs/LogsPanel";

export default function AdminLogsTab({ token }: { token: string }) {
  return <LogsPanel scope="admin" token={token} embedded />;
}
