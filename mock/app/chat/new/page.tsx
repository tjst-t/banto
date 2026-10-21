import { Suspense } from "react";
import { NewChatPage } from "./new-chat-page";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <NewChatPage />
    </Suspense>
  );
}
