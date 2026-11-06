/**
 * No-op provisioner for local tests that never schedule pods.
 */
import type { Provisioner } from "./k8s-types.js";

export class NullProvisioner implements Provisioner {
  async createPod(): Promise<{ podName: string }> {
    throw new Error("NullProvisioner cannot create pods");
  }
  async createWarmPod(): Promise<{ podName: string }> {
    throw new Error("NullProvisioner cannot create warm pods");
  }
  async createWorkspacePvc(): Promise<string> {
    throw new Error("NullProvisioner cannot create PVCs");
  }
  async deleteWorkspacePvc(): Promise<void> {}
  async suspendPod(): Promise<void> {}
  async deletePod(): Promise<void> {}
  async getPod(): Promise<null> {
    return null;
  }
  async nodeAvailable(): Promise<boolean> {
    return true;
  }
  async workspacePvcExists(): Promise<false> {
    return false;
  }
  async listSandboxPods(): Promise<[]> {
    return [];
  }
  async listWarmPods(): Promise<[]> {
    return [];
  }
  async patchPodLabels(): Promise<void> {}
  async getServiceAddress(): Promise<null> {
    return null;
  }
}
