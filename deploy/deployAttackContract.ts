import { createDeployFunction } from "../utils/deploy";

const func = createDeployFunction({
  contractName: "AttackContract",
});

export default func;
