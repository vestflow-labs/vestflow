const { Keypair } = require('@stellar/stellar-sdk');
const kp1 = Keypair.random();
const kp2 = Keypair.random();
console.log(kp1.publicKey());
console.log(kp2.publicKey());
