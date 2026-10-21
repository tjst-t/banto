import { Suspense } from "react";
import { DraftsPage } from "./drafts-page";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <DraftsPage />
    </Suspense>
  );
}
