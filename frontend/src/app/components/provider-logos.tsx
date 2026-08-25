import type { ComponentType } from "react";
import { Image as ImageIcon, ScanText } from "lucide-react";

const providerLogos: Record<string, string> = {
  通义千问: "/img/logos/qwen-icon.png",
  Qwen: "/img/logos/qwen-icon.png",
  Google: "/img/logos/google-brand.png",
  智谱AI: "/img/logos/glm.png",
  GLM: "/img/logos/glm.png",
  DeepSeek: "/img/logos/deepseek-color.png",
  BAAI: "/img/logos/baai.png",
  百度: "/img/logos/baidu.svg",
};

const DARK_INVERT_PROVIDERS = new Set(["BAAI"]);

const idIconMap: Record<string, ComponentType<{ className?: string }>> = {
  "z-image-turbo": ImageIcon,
};

interface ProviderIconProps {
  provider: string;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
  id?: string;
}

const sizeMap = {
  xs: "w-4 h-4",
  sm: "w-5 h-5",
  md: "w-7 h-7",
  lg: "w-9 h-9",
};

export function ProviderIcon({ provider, size = "sm", className = "", id }: ProviderIconProps) {
  const logo = providerLogos[provider];
  const sizeClass = sizeMap[size];

  if (id && (idIconMap[id] || id.toLowerCase().startsWith("ppocr"))) {
    const Icon = idIconMap[id] || ScanText;
    return <Icon className={`${sizeClass} shrink-0 text-muted-foreground ${className}`} />;
  }

  if (logo) {
    const invert = DARK_INVERT_PROVIDERS.has(provider);
    return (
      <img
        src={logo}
        alt={provider}
        className={`${sizeClass} object-contain rounded ${invert ? "dark:invert" : ""} ${className}`}
      />
    );
  }

  return (
    <div
      className={`${sizeClass} rounded bg-secondary text-muted-foreground dark:bg-white/15 dark:text-white/85 flex items-center justify-center text-[9px] shrink-0 ${className}`}
      style={{ fontWeight: 700 }}
    >
      {provider.slice(0, 2)}
    </div>
  );
}
