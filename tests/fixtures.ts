// Public BIP84 vectors, never use this account for real payments:
// https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki#test-vectors
export const ZPUB = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
// The same public account with BIP32 xpub version bytes.
export const XPUB = "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V";
export const FIRST_ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
export const SECOND_ADDRESS = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";
export const SETUP = {
  username: "alice",
  mintUrl: "https://mint.example",
  destinationKey: ZPUB,
  payoutThresholdSats: 100_000,
};
