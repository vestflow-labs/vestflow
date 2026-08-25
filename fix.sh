# Import ToXdr
sed -i '' 's/use soroban_sdk::{/use soroban_sdk::{xdr::ToXdr, /' contracts/vestflow/src/lib.rs

# Fix Hash comparison
sed -i '' 's/if current_hash != root {/if BytesN::<32>::from(current_hash.clone()) != root {/' contracts/vestflow/src/lib.rs

# Fix leaf_hash into BatchSlotClaimed
sed -i '' 's/BatchSlotClaimed(leaf_hash.clone())/BatchSlotClaimed(leaf_hash.clone().into())/g' contracts/vestflow/src/lib.rs

# current_hash type needs to be BytesN<32>? 
# wait, current_hash is updated with current_hash = env.crypto().sha256(&pair_buf);
# In the loop: h1 = current_hash.into(); h1.to_array();
# Let's see how I used it: `let mut h1 = current_hash.to_array();`
# Wait, `soroban_sdk::crypto::Hash<32>` might not have `to_array()`. `BytesN` has `to_array()`.
# Let's convert current_hash to BytesN<32> immediately!

