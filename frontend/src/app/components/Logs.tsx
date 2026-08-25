import { useAuth } from "../hooks/use-auth";
import { LogsPanel } from "./logs/LogsPanel";

export function Logs() {
  const { token, name, department } = useAuth();
  const subtitle = [name, department].filter(Boolean).join(" · ");

  return (
    <LogsPanel
      scope="user"
      token={token ?? ""}
      subtitle={subtitle || undefined}
    />
  );
}
