
fn calculate_vested(total_amount: i128, elapsed: u64, duration: u64) -> i128 {
    if elapsed >= duration {
        total_amount
    } else {
        total_amount * (elapsed as i128) / (duration as i128)
    }
}

fn main() {
    let total_amount = 100;
    let duration = 3;
    
    println!("Total Amount: {}, Duration: {}", total_amount, duration);
    for i in 0..=duration {
        println!("At {}s: {}", i, calculate_vested(total_amount, i, duration));
    }
}
