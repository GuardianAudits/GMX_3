import { createDeployFunction } from "../utils/deploy";

const func = createDeployFunction({
  contractName: "GasGriefingRevertContract",
});

export default func;
