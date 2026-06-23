export const ACTION_HISTORY_KEY = "action_history";
export const ACTION_HISTORY_LIMIT = 40;

export type ActionHistoryEntry = {
  id: string;
  at: string;
  action: string;
  session: string;
  target: string;
  result: "ok" | "error";
  summary: string;
};
