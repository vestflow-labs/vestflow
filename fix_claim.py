import sys
content = open('contracts/vestflow/src/lib.rs').read()
start_idx = content.find('pub fn claim_schedule_slot')
end_idx = content.find('pub fn reclaim_batch')
new_claim = """pub fn claim_schedule_slot(
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

        let leaf_hash: BytesN<32> = env.crypto().sha256(&leaf_buf).into();
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
            
            current_hash = env.crypto().sha256(&pair_buf).into();
        }

        if current_hash != root {
            return Err(VestFlowError::InvalidProof);
        }

        if env.storage().instance().has(&DataKey::BatchSlotClaimed(leaf_hash.clone())) {
            return Err(VestFlowError::SlotAlreadyClaimed);
        }

        // Check BatchRemaining
        let mut remaining: i128 = env.storage().instance().get(&DataKey::BatchRemaining(batch_id)).unwrap();
        if remaining < total_amount {
            panic!("Insufficient batch remaining");
        }
        remaining -= total_amount;
        env.storage().instance().set(&DataKey::BatchRemaining(batch_id), &remaining);
        env.storage().instance().set(&DataKey::BatchSlotClaimed(leaf_hash.clone()), &());

        let token: Address = env.storage().instance().get(&DataKey::BatchToken(batch_id)).unwrap();
        let grantor: Address = env.storage().instance().get(&DataKey::BatchGrantor(batch_id)).unwrap();

        let schedule_id = persist_funded_schedule(
            &env,
            grantor.clone(),
            beneficiary.clone(),
            token,
            total_amount,
            start_time,
            duration,
            cliff_duration,
            cliff_duration, // lockup_duration defaults to cliff
            vesting_kind,
            revocable
        );

        Ok(schedule_id)
    }

    """
content = content[:start_idx] + new_claim + content[end_idx:]
open('contracts/vestflow/src/lib.rs', 'w').write(content)
