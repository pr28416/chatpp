import * as React from "react";
import { Chat } from "@/lib/types";
import { fetchChats } from "@/lib/commands";
import { ChatList } from "@/components/chat-list";
import { MessageView } from "@/components/message-view";

export default function App() {
  const [chats, setChats] = React.useState<Chat[]>([]);
  const [selectedChatId, setSelectedChatId] = React.useState<number | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    fetchChats()
      .then((data) => {
        setChats(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch chats:", err);
        setError(
          "Failed to load conversations. Make sure Full Disk Access is enabled for this app in System Settings > Privacy & Security.",
        );
        setLoading(false);
      });
  }, []);

  const selectedChat = chats.find((c) => c.id === selectedChatId) || null;

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center p-8">
        <div className="text-center max-w-md">
          <h1 className="text-xl font-semibold text-destructive mb-2">
            Connection Error
          </h1>
          <p className="text-muted-foreground text-sm">{error}</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Loading conversations...</p>
      </div>
    );
  }

  return (
    <div className="h-screen flex overflow-hidden">
      <div className="w-80 flex-shrink-0">
        <ChatList
          chats={chats}
          selectedChatId={selectedChatId}
          onSelectChat={setSelectedChatId}
        />
      </div>
      <MessageView chat={selectedChat} />
    </div>
  );
}
