use soroban_sdk::{Env, Address};
pub fn test(env: Env, addr: Address) {
    let _ = addr.to_xdr(&env);
}
