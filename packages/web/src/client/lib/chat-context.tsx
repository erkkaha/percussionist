import { createContext, useContext } from "react";
import type { Task } from "./types";

export interface ChatContextValue {
  injectTask: (task: Task, projectName: string) => void;
}

export const ChatContext = createContext<ChatContextValue>({
  injectTask: () => {},
});

export function useChat(): ChatContextValue {
  return useContext(ChatContext);
}
