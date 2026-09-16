export function rdsOutputs(value: {
  readonly Endpoint?: { readonly Address?: string; readonly Port?: string };
  readonly MasterUserSecret?: { readonly SecretArn?: string };
}): { readonly endpoint: string; readonly port: number; readonly secretArn: string } {
  const endpoint = value.Endpoint;
  const secretArn = value.MasterUserSecret?.SecretArn;
  const port = Number(endpoint?.Port);
  if (
    !endpoint?.Address ||
    !endpoint.Port ||
    !/^\d+$/.test(endpoint.Port) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !secretArn
  ) {
    throw new Error("RDS provider did not return the required endpoint and secret outputs.");
  }
  return { endpoint: endpoint.Address, port, secretArn };
}
