//! Detached price certificates. A prior Ed25519 precompile verifies the signature;
//! this module binds its exact bytes to this devnet program, round, pool and window.
use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use crate::{ErrorCode, OracleConfig, PriceSample, Round};

pub const DOMAIN: &[u8] = b"FlipTheMeme devnet price v1\0";

pub fn message(round_key: &Pubkey, round: &Round, kind: u8, samples: &[PriceSample]) -> Vec<u8> {
    let (start, end) = if kind == 0 { (round.strike_start, round.strike_end) } else { (round.exit_start, round.exit_end) };
    let mut out = Vec::with_capacity(160 + samples.len() * 16);
    out.extend_from_slice(DOMAIN);
    out.extend_from_slice(crate::ID.as_ref());
    out.extend_from_slice(round_key.as_ref());
    out.extend_from_slice(round.pool.as_ref());
    out.push(kind);
    out.extend_from_slice(&start.to_le_bytes());
    out.extend_from_slice(&end.to_le_bytes());
    out.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.slot.to_le_bytes());
        out.extend_from_slice(&sample.price.to_le_bytes());
    }
    out
}

pub fn verify(instructions: &AccountInfo, oracle: &OracleConfig, expected: &[u8]) -> Result<()> {
    require!(oracle.attestor != Pubkey::default(), ErrorCode::AttestationInvalid);
    let index = load_current_index_checked(instructions)?;
    require!(index > 0, ErrorCode::AttestationInvalid);
    let current = load_instruction_at_checked(index as usize, instructions)?;
    require_keys_eq!(current.program_id, crate::ID, ErrorCode::AttestationInvalid);
    let ix = load_instruction_at_checked(index as usize - 1, instructions)?;
    let ed = pubkey!("Ed25519SigVerify111111111111111111111111111");
    require_keys_eq!(ix.program_id, ed, ErrorCode::AttestationInvalid);
    let d = &ix.data;
    // Only one self-contained signature is accepted. Cross-instruction offsets,
    // trailing messages and zero-signature precompiles cannot stand in for a proof.
    require!(ix.accounts.is_empty() && d.len() == 112 + expected.len(), ErrorCode::AttestationInvalid);
    require!(d[0] == 1 && d[1] == 0, ErrorCode::AttestationInvalid);
    let fields = [16u16, u16::MAX, 80, u16::MAX, 112, expected.len() as u16, u16::MAX];
    for (i, value) in fields.iter().enumerate() {
        require!(&d[2 + i * 2..4 + i * 2] == value.to_le_bytes(), ErrorCode::AttestationInvalid);
    }
    require!(&d[80..112] == oracle.attestor.as_ref() && &d[112..] == expected, ErrorCode::AttestationInvalid);
    Ok(())
}
