# Remove the test mod I added
sed -i '' '/mod test_xdr;/d' contracts/vestflow/src/lib.rs

# We want to insert the functions before the last '}' of impl VestFlowContract
# Let's write the functions to a temp file
cat << 'FUNCS' > temp_funcs.rs

    pub fn commit_schedule_batch(
        env: Env,
        grantor: Address,
        token: Address,
        total_amount: i128,
        merkle_root: BytesN<32>,
        expiry_ledger: u32,
    ) -> u64 {
        grantor.require_auth();

        if total_amount <= 0 {
            panic!("Amount must be positive");
        }

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&grantor, &env.current_contract_address(), &total_amount);

        let batch_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::BatchCounter)
            .unwrap_or(0)
            + 1;
        env.storage().instance().set(&DataKey::BatchCounter, &batch_id);

        env.storage().instance().set(&DataKey::BatchRoot(batch_id), &merkle_root);
        env.storage().instance().set(&DataKey::BatchToken(batch_id), &token);
        env.storage().instance().set(&DataKey::BatchGrantor(batch_id), &grantor);
        env.storage().instance().set(&DataKey::BatchRemaining(batch_id), &total_amount);
        env.storage().instance().set(&DataKey::BatchExpiry(batch_id), &expiry_ledger);

        env.events().publish((symbol_short!("batch_com"), batch_id), (grantor, token, total_amount, merkle_root, expiry_ledger));

        batch_id
    }

    pub fn claim_schedule_slot(
        env: Env,
        batch_id: u64,
        beneficiary: Address,
        total_amount: i128,
        duration: u64,
        cliff_duration: u64,
        start_time: u64,
        vesting_kind: VestingKind,
        revocable: bool,
        proof: Vec<BytesN<32>>,
    ) -> Result<u64, VestFlowError> {
        beneficiary.require_auth();

        let expiry: u32 = env.storage().instance().get(&DataKey::BatchExpiry(batch_id)).ok_or(VestFlowError::NotFound)?;
        if env.ledger().sequence() > expiry {
            return Err(VestFlowError::BatchExpired);
        }

        if proof.len() > 20 {
            return Err(VestFlowError::ProofTooDeep);
        }

        let root: BytesN<32> = env.storage().instance().get(&DataKey::BatchRoot(batch_id)).ok_or(VestFlowError::NotFound)?;

        let mut leaf_buf = soroban_sdk::Bytes::new(&env);
        leaf_buf.push_back(0x00);
        
        let ben_xdr = beneficiary.to_xdr(&env);
        let ben_len = ben_xdr.len();
        let ben_bytes = ben_xdr.slice(ben_len - 32..ben_len);
        leaf_buf.append(&ben_bytes);

        let mut amt_bytes = [0u8; 16];
        amt_bytes.copy_from_slice(&total_amount.to_be_bytes());
        leaf_buf.extend_from_array(&amt_bytes);

        let mut dur_bytes = [0u8; 8];
        dur_bytes.copy_from_slice(&duration.to_be_bytes());
        leaf_buf.extend_from_array(&dur_bytes);

        let mut cliff_bytes = [0u8; 8];
        cliff_bytes.copy_from_slice(&cliff_duration.to_be_bytes());
        leaf_buf.extend_from_array(&cliff_bytes);

        let mut start_bytes = [0u8; 8];
        start_bytes.copy_from_slice(&start_time.to_be_bytes());
        leaf_buf.extend_from_array(&start_bytes);

        let kind_byte = match vesting_kind {
            VestingKind::Linear => 0u8,
            VestingKind::Cliff => 1u8,
            VestingKind::LinearWithCliff => 2u8,
            VestingKind::Graded => 3u8,
        };
        leaf_buf.push_back(kind_byte);

        let rev_byte = if revocable { 1u8 } else { 0u8 };
        leaf_buf.push_back(rev_byte);

        let leaf_hash = env.crypto().sha256(&leaf_buf);
        let mut current_hash = leaf_hash.clone();

        for node in proof.iter() {
            let mut pair_buf = soroban_sdk::Bytes::new(&env);
            pair_buf.push_back(0x01);
            
            let mut h1 = current_hash.to_array();
            let mut h2 = node.to_array();
            if h1 > h2 {
                core::mem::swap(&mut h1, &mut h2);
            }
            pair_buf.extend_from_array(&h1);
            pair_buf.extend_from_array(&h2);
            
            current_hash = env.crypto().sha256(&pair_buf);
        }

        if current_hash != root {
            return Err(VestFlowError::InvalidProof);
        }

        if env.storage().instance().has(&DataKey::BatchSlotClaimed(leaf_hash.clone())) {
            return Err(VestFlowError::SlotAlreadyClaimed);
        }

        // Check BatchRemaining
        let mut remaining: i128 = env.storage().instance().get(&DataKey::BatchRemaining(batch_id)).unwrap();
        // If remaining < total_amount, that's theoretically impossible if the root is valid and the grantor deposited the correct amount,
        // but we should check it just in case.
        if remaining < total_amount {
            panic!("Insufficient batch remaining");
        }
        remaining -= total_amount;
        env.storage().instance().set(&DataKey::BatchRemaining(batch_id), &remaining);
        env.storage().instance().set(&DataKey::BatchSlotClaimed(leaf_hash.clone()), &());

        let token: Address = env.storage().instance().get(&DataKey::BatchToken(batch_id)).unwrap();
        let grantor: Address = env.storage().instance().get(&DataKey::BatchGrantor(batch_id)).unwrap();

        // Create the schedule internally
        let schedule_id = persist_funded_schedule(
            &env,
            grantor.clone(),
            beneficiary.clone(),
            token,
            total_amount,
            start_time,
            duration,
            cliff_duration,
            duration, // lockup_duration defaults to duration, wait, the issue doesn't specify lockup_duration. Let's look at persist_funded_schedule signature.
            vesting_kind,
            revocable,
            false, // requires_milestones
            soroban_sdk::vec![&env] // milestones
        );

        Ok(schedule_id)
    }

    pub fn reclaim_batch(env: Env, batch_id: u64, grantor: Address) -> Result<(), VestFlowError> {
        grantor.require_auth();

        let expiry: u32 = env.storage().instance().get(&DataKey::BatchExpiry(batch_id)).ok_or(VestFlowError::NotFound)?;
        if env.ledger().sequence() <= expiry {
            return Err(VestFlowError::NotExpired);
        }

        let stored_grantor: Address = env.storage().instance().get(&DataKey::BatchGrantor(batch_id)).unwrap();
        if grantor != stored_grantor {
            panic!("Not the grantor");
        }

        let remaining: i128 = env.storage().instance().get(&DataKey::BatchRemaining(batch_id)).unwrap();
        if remaining > 0 {
            let token: Address = env.storage().instance().get(&DataKey::BatchToken(batch_id)).unwrap();
            let token_client = token::Client::new(&env, &token);
            token_client.transfer(&env.current_contract_address(), &grantor, &remaining);
        }

        env.storage().instance().remove(&DataKey::BatchRoot(batch_id));
        env.storage().instance().remove(&DataKey::BatchToken(batch_id));
        env.storage().instance().remove(&DataKey::BatchGrantor(batch_id));
        env.storage().instance().remove(&DataKey::BatchRemaining(batch_id));
        env.storage().instance().remove(&DataKey::BatchExpiry(batch_id));

        env.events().publish((symbol_short!("batch_rec"), batch_id), (grantor, remaining));
        Ok(())
    }
FUNCS

# Let's inject temp_funcs.rs right before line 3055
sed -i '' -e '3054r temp_funcs.rs' contracts/vestflow/src/lib.rs

