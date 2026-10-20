//! TIME Dividend na Solanie — token, którego posiadacze dostają udział w SOL
//! wpłacanym do programu (odpowiednik T.I.M.E. Dividend z PulseChain).
//!
//! Token to mint Token-2022 z rozszerzeniem Transfer Hook wskazującym na ten
//! program. Hook wywoływany przy każdym transferze aktualizuje „korekty”
//! (magnifiedDividendCorrections z TIME), więc dywidenda podąża za tokenem
//! bez stakowania.
//!
//! Zmiany względem TIME (PulseChain):
//!  1. Udział jest dobrowolny (`register`). Pule DEX, kontrakty spalające i giełdy
//!     nie mogą się zarejestrować, więc nie „zjadają” dywidendy — w TIME część
//!     wypłat utyka na adresach puli/burn na zawsze.
//!  2. Reszta z dzielenia przechodzi na kolejną wypłatę (`carry`) — zero strat
//!     na zaokrągleniach.
//!  3. Wpłaty jak w TIME `receive()`: każdy może wysłać SOL bezpośrednio na
//!     adres konfiguracji, a `distribute` (bez uprawnień) rozdziela nadwyżkę.
//!  4. `initialize` sprawdza on-chain, że mint nie ma admina: brak mint/freeze
//!     authority, brak autorytetu hooka, brak permanent delegate itp.
//!  5. Odporność na `burn` (Token-2022 nie wywołuje hooka przy spalaniu):
//!     saldo jest synchronizowane przy każdej operacji (`last_balance`).
//!  6. Częściowy odbiór, odbiór na dowolny adres, `unregister` zwraca czynsz.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_discriminator::SplDiscriminate;
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList};
use spl_token_2022::extension::{
    transfer_hook::{TransferHook as TransferHookExt, TransferHookAccount},
    BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

declare_id!("CfW1pzZgwzRAYb4DfnAofQ2GRBkFJFrxHAaCurEUBpao");

pub const CONFIG_SEED: &[u8] = b"config";
pub const HOLDER_SEED: &[u8] = b"holder";
pub const META_SEED: &[u8] = b"extra-account-metas";

/// Skala dla dywidendy na jednostkę tokena (jak `magnitude` w TIME, tu 2^64,
/// bo kwoty na Solanie to u64).
pub const MAGNITUDE: u128 = 1 << 64;

#[program]
pub mod time_dividend {
    use super::*;

    /// Tworzy konfigurację i listę dodatkowych kont dla hooka.
    /// Odmawia, jeśli mint ma jakąkolwiek formę administratora.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        verify_mint_has_no_admin(&ctx.accounts.mint.to_account_info())?;

        let metas = extra_account_metas()?;
        let mut data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &metas)?;

        let cfg = &mut ctx.accounts.config;
        cfg.mint = ctx.accounts.mint.key();
        cfg.mag_per_share = 0;
        cfg.carry = 0;
        cfg.registered_supply = 0;
        cfg.total_distributed = 0;
        cfg.total_claimed = 0;
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    /// Właściciel konta tokenowego dołącza je do podziału dywidendy.
    /// Konto zaczyna zarabiać od wypłat dokonanych po rejestracji.
    pub fn register(ctx: Context<Register>) -> Result<()> {
        let balance = ctx.accounts.token_account.amount;
        let cfg = &mut ctx.accounts.config;
        let h = &mut ctx.accounts.holder;

        h.token_account = ctx.accounts.token_account.key();
        h.last_balance = balance;
        h.correction = -to_i128(mul(cfg.mag_per_share, balance)?)?;
        h.claimed = 0;
        h.bump = ctx.bumps.holder;

        cfg.registered_supply = cfg
            .registered_supply
            .checked_add(balance)
            .ok_or(DividendError::MathOverflow)?;

        emit!(Registered { token_account: h.token_account, balance });
        Ok(())
    }

    /// Wpłaca `amount` lamportów (może być 0) i rozdziela całą nierozliczoną
    /// nadwyżkę SOL na koncie konfiguracji — także SOL wysłane tam zwykłym
    /// przelewem. Może wywołać każdy.
    pub fn distribute(ctx: Context<Distribute>, amount: u64) -> Result<()> {
        if amount > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: ctx.accounts.config.to_account_info(),
                    },
                ),
                amount,
            )?;
        }

        let cfg_info = ctx.accounts.config.to_account_info();
        let rent_min = Rent::get()?.minimum_balance(cfg_info.data_len());
        let lamports = cfg_info.lamports();

        let cfg = &mut ctx.accounts.config;
        require!(cfg.registered_supply > 0, DividendError::NoParticipants);

        let owed = cfg.total_distributed - cfg.total_claimed;
        let fresh = lamports.saturating_sub(rent_min).saturating_sub(owed);
        require!(fresh > 0, DividendError::NothingToDistribute);

        let total = (fresh as u128)
            .checked_mul(MAGNITUDE)
            .and_then(|v| v.checked_add(cfg.carry))
            .ok_or(DividendError::MathOverflow)?;
        let supply = cfg.registered_supply as u128;
        cfg.mag_per_share = cfg
            .mag_per_share
            .checked_add(total / supply)
            .ok_or(DividendError::MathOverflow)?;
        cfg.carry = total % supply;
        cfg.total_distributed = cfg
            .total_distributed
            .checked_add(fresh)
            .ok_or(DividendError::MathOverflow)?;

        emit!(DistributeDividend { from: ctx.accounts.payer.key(), lamports: fresh });
        Ok(())
    }

    /// Odbiera dywidendę na `recipient`. `amount == 0` oznacza całość.
    pub fn claim(ctx: Context<Claim>, amount: u64) -> Result<()> {
        let balance = ctx.accounts.token_account.amount;
        let paid = settle_claim(
            &mut ctx.accounts.config,
            &mut ctx.accounts.holder,
            balance,
            amount,
            &ctx.accounts.recipient.to_account_info(),
        )?;
        require!(paid > 0, DividendError::NothingToClaim);
        Ok(())
    }

    /// Wypłaca całą dywidendę właścicielowi, wycofuje konto z podziału
    /// i zamyka rekord `holder` (zwrot czynszu).
    pub fn unregister(ctx: Context<Unregister>) -> Result<()> {
        let balance = ctx.accounts.token_account.amount;
        let owner_info = ctx.accounts.owner.to_account_info();
        settle_claim(&mut ctx.accounts.config, &mut ctx.accounts.holder, balance, 0, &owner_info)?;

        let cfg = &mut ctx.accounts.config;
        let h = &ctx.accounts.holder;
        cfg.registered_supply = cfg
            .registered_supply
            .checked_sub(h.last_balance)
            .ok_or(DividendError::MathOverflow)?;
        emit!(Unregistered { token_account: h.token_account });
        Ok(())
    }

    /// Wywoływane przez Token-2022 przy każdym transferze tokena.
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn transfer_hook(ctx: Context<TransferHook>, _amount: u64) -> Result<()> {
        assert_is_transferring(&ctx.accounts.source_token.to_account_info())?;

        let src = ctx.accounts.source_token.key();
        let dst = ctx.accounts.destination_token.key();
        if src == dst {
            return Ok(());
        }

        let cfg = &mut ctx.accounts.config;
        sync_holder_account(
            &ctx.accounts.source_holder.to_account_info(),
            src,
            ctx.accounts.source_token.amount,
            cfg,
        )?;
        sync_holder_account(
            &ctx.accounts.destination_holder.to_account_info(),
            dst,
            ctx.accounts.destination_token.amount,
            cfg,
        )?;
        Ok(())
    }
}

// ---------------------------------------------------------------- konta

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub mint: Pubkey,
    /// Skumulowana dywidenda na jednostkę tokena × MAGNITUDE.
    pub mag_per_share: u128,
    /// Reszta z ostatniego dzielenia (w jednostkach × MAGNITUDE).
    pub carry: u128,
    /// Suma sald zarejestrowanych kont — tylko one dzielą dywidendę.
    pub registered_supply: u64,
    pub total_distributed: u64,
    pub total_claimed: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Holder {
    pub token_account: Pubkey,
    /// Saldo widziane przy ostatniej synchronizacji.
    pub last_balance: u64,
    pub correction: i128,
    pub claimed: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED, mint.key().as_ref()],
        bump
    )]
    pub config: Account<'info, Config>,
    /// CHECK: inicjalizowane w instrukcji jako ExtraAccountMetaList
    #[account(
        init,
        payer = payer,
        space = ExtraAccountMetaList::size_of(3).unwrap(),
        seeds = [META_SEED, mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: AccountInfo<'info>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Register<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED, mint.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        token::mint = mint,
        token::authority = owner,
        token::token_program = token_program
    )]
    pub token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = owner,
        space = 8 + Holder::INIT_SPACE,
        seeds = [HOLDER_SEED, token_account.key().as_ref()],
        bump
    )]
    pub holder: Account<'info, Holder>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Distribute<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED, config.mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED, mint.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// Właściciel sprawdzany na bieżąco — działa też po zmianie właściciela konta.
    #[account(token::mint = mint, token::authority = owner)]
    pub token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [HOLDER_SEED, token_account.key().as_ref()],
        bump = holder.bump,
        has_one = token_account
    )]
    pub holder: Account<'info, Holder>,
    /// CHECK: dowolny odbiorca SOL
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Unregister<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED, mint.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = mint, token::authority = owner)]
    pub token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        close = owner,
        seeds = [HOLDER_SEED, token_account.key().as_ref()],
        bump = holder.bump,
        has_one = token_account
    )]
    pub holder: Account<'info, Holder>,
}

/// Kolejność kont 0–4 narzuca interfejs Transfer Hook; 5–7 to dodatkowe konta
/// z ExtraAccountMetaList.
#[derive(Accounts)]
pub struct TransferHook<'info> {
    #[account(token::mint = mint)]
    pub source_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = mint)]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: właściciel lub delegat — nieużywany
    pub owner: UncheckedAccount<'info>,
    /// CHECK: sprawdzane seedami
    #[account(seeds = [META_SEED, mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    #[account(mut, seeds = [CONFIG_SEED, mint.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: może nie istnieć (konto niezarejestrowane)
    #[account(mut, seeds = [HOLDER_SEED, source_token.key().as_ref()], bump)]
    pub source_holder: UncheckedAccount<'info>,
    /// CHECK: może nie istnieć (konto niezarejestrowane)
    #[account(mut, seeds = [HOLDER_SEED, destination_token.key().as_ref()], bump)]
    pub destination_holder: UncheckedAccount<'info>,
}

// ---------------------------------------------------------------- logika

fn extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
    // Indeksy: 0 = konto źródłowe, 1 = mint, 2 = konto docelowe.
    Ok(vec![
        ExtraAccountMeta::new_with_seeds(
            &[Seed::Literal { bytes: CONFIG_SEED.to_vec() }, Seed::AccountKey { index: 1 }],
            false,
            true,
        )?,
        ExtraAccountMeta::new_with_seeds(
            &[Seed::Literal { bytes: HOLDER_SEED.to_vec() }, Seed::AccountKey { index: 0 }],
            false,
            true,
        )?,
        ExtraAccountMeta::new_with_seeds(
            &[Seed::Literal { bytes: HOLDER_SEED.to_vec() }, Seed::AccountKey { index: 2 }],
            false,
            true,
        )?,
    ])
}

fn verify_mint_has_no_admin(mint: &AccountInfo) -> Result<()> {
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data)?;

    require!(state.base.mint_authority.is_none(), DividendError::MintAuthorityActive);
    require!(state.base.freeze_authority.is_none(), DividendError::FreezeAuthorityActive);

    let hook = state
        .get_extension::<TransferHookExt>()
        .map_err(|_| error!(DividendError::WrongTransferHook))?;
    require!(
        Option::<Pubkey>::from(hook.program_id) == Some(crate::ID),
        DividendError::WrongTransferHook
    );
    require!(
        Option::<Pubkey>::from(hook.authority).is_none(),
        DividendError::HookAuthorityActive
    );

    for ext in state.get_extension_types()? {
        match ext {
            ExtensionType::PermanentDelegate
            | ExtensionType::MintCloseAuthority
            | ExtensionType::DefaultAccountState
            | ExtensionType::NonTransferable
            | ExtensionType::TransferFeeConfig
            | ExtensionType::ConfidentialTransferMint
            | ExtensionType::InterestBearingConfig => {
                return err!(DividendError::ForbiddenExtension)
            }
            _ => {}
        }
    }
    Ok(())
}

/// Blokuje bezpośrednie wywołanie hooka z pominięciem Token-2022.
fn assert_is_transferring(source: &AccountInfo) -> Result<()> {
    let data = source.try_borrow_data()?;
    let acc = StateWithExtensions::<spl_token_2022::state::Account>::unpack(&data)?;
    let ext = acc.get_extension::<TransferHookAccount>()?;
    require!(bool::from(ext.transferring), DividendError::NotTransferring);
    Ok(())
}

fn mul(mag_per_share: u128, amount: u64) -> Result<u128> {
    mag_per_share
        .checked_mul(amount as u128)
        .ok_or_else(|| error!(DividendError::MathOverflow))
}

fn to_i128(v: u128) -> Result<i128> {
    i128::try_from(v).map_err(|_| error!(DividendError::MathOverflow))
}

/// Przenosi zmianę salda do korekty — skumulowana dywidenda konta się nie zmienia,
/// zmienia się tylko udział w przyszłych wypłatach.
fn apply_balance(cfg: &mut Config, h: &mut Holder, new_balance: u64) -> Result<()> {
    if new_balance > h.last_balance {
        let d = new_balance - h.last_balance;
        h.correction = h
            .correction
            .checked_sub(to_i128(mul(cfg.mag_per_share, d)?)?)
            .ok_or(DividendError::MathOverflow)?;
        cfg.registered_supply = cfg
            .registered_supply
            .checked_add(d)
            .ok_or(DividendError::MathOverflow)?;
    } else if new_balance < h.last_balance {
        let d = h.last_balance - new_balance;
        h.correction = h
            .correction
            .checked_add(to_i128(mul(cfg.mag_per_share, d)?)?)
            .ok_or(DividendError::MathOverflow)?;
        cfg.registered_supply = cfg
            .registered_supply
            .checked_sub(d)
            .ok_or(DividendError::MathOverflow)?;
    }
    h.last_balance = new_balance;
    Ok(())
}

fn accumulated(cfg: &Config, h: &Holder) -> Result<u64> {
    let total = to_i128(mul(cfg.mag_per_share, h.last_balance)?)?
        .checked_add(h.correction)
        .ok_or(DividendError::MathOverflow)?;
    require!(total >= 0, DividendError::MathOverflow);
    u64::try_from(total as u128 / MAGNITUDE).map_err(|_| error!(DividendError::MathOverflow))
}

fn settle_claim(
    cfg: &mut Account<Config>,
    h: &mut Account<Holder>,
    balance: u64,
    amount: u64,
    recipient: &AccountInfo,
) -> Result<u64> {
    apply_balance(cfg, h, balance)?;
    let claimable = accumulated(cfg, h)?.saturating_sub(h.claimed);
    let pay = if amount == 0 || amount > claimable { claimable } else { amount };
    if pay == 0 {
        return Ok(0);
    }

    h.claimed = h.claimed.checked_add(pay).ok_or(DividendError::MathOverflow)?;
    cfg.total_claimed = cfg.total_claimed.checked_add(pay).ok_or(DividendError::MathOverflow)?;

    let cfg_info = cfg.to_account_info();
    let rent_min = Rent::get()?.minimum_balance(cfg_info.data_len());
    require!(
        cfg_info.lamports().saturating_sub(pay) >= rent_min,
        DividendError::VaultInsufficient
    );
    cfg.sub_lamports(pay)?;
    recipient.add_lamports(pay)?;

    emit!(ClaimDividend { token_account: h.token_account, recipient: recipient.key(), lamports: pay });
    Ok(pay)
}

/// Synchronizuje rekord `holder`, jeśli istnieje; konta niezarejestrowane pomija.
fn sync_holder_account(info: &AccountInfo, token_account: Pubkey, balance: u64, cfg: &mut Config) -> Result<()> {
    if info.owner != &crate::ID || info.data_is_empty() {
        return Ok(());
    }
    let mut data = info.try_borrow_mut_data()?;
    let mut h = Holder::try_deserialize(&mut &data[..])?;
    require_keys_eq!(h.token_account, token_account, DividendError::HolderMismatch);
    apply_balance(cfg, &mut h, balance)?;
    let mut out: &mut [u8] = &mut data[..];
    h.try_serialize(&mut out)?;
    Ok(())
}

// ---------------------------------------------------------------- zdarzenia i błędy

#[event]
pub struct Registered {
    pub token_account: Pubkey,
    pub balance: u64,
}

#[event]
pub struct Unregistered {
    pub token_account: Pubkey,
}

#[event]
pub struct DistributeDividend {
    pub from: Pubkey,
    pub lamports: u64,
}

#[event]
pub struct ClaimDividend {
    pub token_account: Pubkey,
    pub recipient: Pubkey,
    pub lamports: u64,
}

#[error_code]
pub enum DividendError {
    #[msg("Mint ma aktywny mint authority — podaż nie jest stała")]
    MintAuthorityActive,
    #[msg("Mint ma freeze authority — ktoś mógłby zamrażać konta")]
    FreezeAuthorityActive,
    #[msg("Transfer hook mintu nie wskazuje na ten program")]
    WrongTransferHook,
    #[msg("Transfer hook ma autorytet — ktoś mógłby podmienić program")]
    HookAuthorityActive,
    #[msg("Mint ma niedozwolone rozszerzenie (permanent delegate, opłaty itp.)")]
    ForbiddenExtension,
    #[msg("Hook wywołany poza transferem Token-2022")]
    NotTransferring,
    #[msg("Brak zarejestrowanych posiadaczy")]
    NoParticipants,
    #[msg("Brak nowego SOL do rozdzielenia")]
    NothingToDistribute,
    #[msg("Brak dywidendy do odebrania")]
    NothingToClaim,
    #[msg("Za mało SOL w skarbcu")]
    VaultInsufficient,
    #[msg("Rekord holder nie pasuje do konta tokenowego")]
    HolderMismatch,
    #[msg("Przepełnienie arytmetyczne")]
    MathOverflow,
}
