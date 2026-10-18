import {
  HTTPFacilitatorClient,
  x402ResourceServer,
} from "@x402/core/server";

import {
  USDC_TESTNET_ASA_ID,
} from "@x402/avm";

import { ExactAvmScheme } from "@x402/avm/exact/server";

const facilitatorUrl =
  process.env["FACILITATOR_URL"] ||
  "https://facilitator.goplausible.xyz";

const payTo = process.env["X402_PAY_TO"];

if (!payTo) {
  throw new Error(
    "X402_PAY_TO environment variable is required",
  );
}

const facilitatorClient =
  new HTTPFacilitatorClient({
    url: facilitatorUrl,
  });

export const x402Server =
  new x402ResourceServer(
    facilitatorClient,
  );

// GoPlausible-supported Algorand Testnet
const ALGORAND_TESTNET_NETWORK =
  "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=" as `${string}:${string}`;

x402Server.register(
  ALGORAND_TESTNET_NETWORK,
  new ExactAvmScheme(),
);

export const premiumAnalysisPayment = {
  scheme: "exact" as const,

  network:
    ALGORAND_TESTNET_NETWORK,

  payTo,

  price: {
    asset: USDC_TESTNET_ASA_ID,
    amount: "10000",

    extra: {
      name: "USDC",
      decimals: 6,
    },
  },

  maxTimeoutSeconds: 60,
};