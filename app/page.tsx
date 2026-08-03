import { WriterApp } from "./writer-app";
import { chatGPTSignOutPath, requireChatGPTUser } from "./chatgpt-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const account = await requireChatGPTUser("/");

  return (
    <WriterApp
      accountEmail={account.email}
      signOutPath={chatGPTSignOutPath("/")}
    />
  );
}
