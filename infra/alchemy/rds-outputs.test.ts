import { expect, test } from "bun:test";
import { rdsOutputs } from "./rds-outputs";

test("accepts the real Cloud Control RDS string port and rejects malformed outputs", () => {
  const fixture = {
    Endpoint: { Address: "database.example", Port: "5432" },
    MasterUserSecret: { SecretArn: "secret-identifier" },
  };
  expect(rdsOutputs(fixture)).toEqual({
    endpoint: "database.example",
    port: 5432,
    secretArn: "secret-identifier",
  });
  for (const Port of ["", "0", "65536", "5432x", "1.5"]) {
    expect(() => rdsOutputs({ ...fixture, Endpoint: { ...fixture.Endpoint, Port } })).toThrow();
  }
  expect(() => rdsOutputs({})).toThrow();
});
