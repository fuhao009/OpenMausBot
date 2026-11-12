export type ExecutionTool = "claude" | "codex" | "omp";
export type ExecutionLocation = "local" | "server";
export interface ExecutionConnector {
  id: string;
  tool: ExecutionTool;
  location: ExecutionLocation;
  state: "connected" | "disconnected";
  botIds: string[];
  createdAt: number;
}
export interface ExecutionApproval { id: string; title: string; detail: string; kind: "permission" | "question"; choices?: string[] }
export interface ExecutionTask {
  id: string;
  connectorId: string;
  botId: string;
  status: "running" | "approval" | "completed" | "failed" | "cancelled";
  text: string;
  error?: string;
  approvals: ExecutionApproval[];
  createdAt: number;
}
export interface ExecutionConnectorList {
  localAvailable: boolean;
  canManage: boolean;
  connectors: ExecutionConnector[];
  tasks: ExecutionTask[];
}
export interface CreateExecutionConnector {
  tool: ExecutionTool;
  location: ExecutionLocation;
  consent: true;
  botIds: string[];
  remoteUrl?: string;
  remoteToken?: string;
}
export interface ApproveExecutionTask { requestId: string; allow: boolean; answer?: string }
export interface StartExecutionTask { botId: string; prompt: string }
