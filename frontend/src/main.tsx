import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { initCompat } from "./app/compat-init";
import { App } from "./app/App";
import { AuthProvider } from "./app/hooks/use-auth";
import { I18nProvider } from "./app/i18n";
import { AppErrorBoundary } from "./app/components/AppErrorBoundary";
import { PlatformConfigProvider } from "./app/hooks/use-platform-config";
import "./styles/index.css";

initCompat();

// 主题（含 system 模式解析）与 lang 属性已由 index.html 里的内联同步脚本
// 在首帧前处理完毕，此处无需重复，重复反而会因为只认字面量 "dark" 而漏判 system 模式。

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>
        <PlatformConfigProvider>
          <I18nProvider>
            <AuthProvider>
              <App />
            </AuthProvider>
          </I18nProvider>
        </PlatformConfigProvider>
      </BrowserRouter>
    </AppErrorBoundary>
  </React.StrictMode>
);
