/**
 * Signing a signature field with the signer's PIN (Flora Leaf). Without a provider (Canopy, designer previews) a drawn
 * signature is stored as drawn. With one, the drawing is signed through `sign` (PIN checked by the Leaf, which stores
 * {data, signed_at, signer, signer_name, verified: "pin"}), and a confirmed signature is locked unless `canResign`
 * (an amendment with a reason is open).
 */
import { createContext } from "react";

export type SigningService = {
  sign: (fieldKey: string, data: string) => Promise<void>;
  canResign: boolean;
};

export const SignatureContext = createContext<SigningService | null>(null);
