import { AdminServerMonitor } from "./admin-server-monitor";

export default function InfraTab({ token }: { token: string }) {
  return <AdminServerMonitor token={token} />;
}
