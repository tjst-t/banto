import { Suspense } from "react";
import { SettingsContent } from "./settings-content";

export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsContent />
    </Suspense>
  );
}
