#[cfg(test)]
mod tests {
    use soroban_sdk::{Env, Address};
    #[test]
    fn test_address_xdr() {
        let env = Env::default();
        let addr = Address::generate(&env);
        let xdr = addr.to_xdr(&env);
        std::println!("XDR len: {}, bytes: {:?}", xdr.len(), xdr.to_alloc_vec());
    }
}
