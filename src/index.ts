import { Multisig, TOKEN_PROGRAM_ID, createInitializeMultisigInstruction, getMultisig, createInitializeMintInstruction, createMintToInstruction, Mint, getMint, getOrCreateAssociatedTokenAccount, Account } from "@solana/spl-token";
import fs from 'mz/fs'
import os from 'os'
import path from 'path'
import yaml from 'yaml'
import BN from "bn.js"
import {Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js"

const CONFIG_FILE_PATH = path.resolve(os.homedir(), '.config', 'solana', 'cli', 'config.yml')
const connection = new Connection("http://127.0.0.1:8899", 'confirmed')
const INITIALIZE_MINT_SPAN = 82
const INITIALIZE_MULTISIG_SPAN = 355


const getDefaultAccount =  async (): Promise<Keypair> => {
    try {
      const config = await readSolanaConfig();
      if (!config.keypair_path) throw new Error('Missing keypair path');
      return readAccountFromFile(config.keypair_path);
    } catch (err) {
      console.warn(
        'Failed to read keypair from CLI config file, falling back to new random keypair',
      );
      return new Keypair();
    }
}

const readSolanaConfig = async (): Promise<any> => {
    const configYml = await fs.readFile(CONFIG_FILE_PATH, { encoding: 'utf8' });
    return yaml.parse(configYml);
}

const readAccountFromFile = async (filePath: string): Promise<Keypair> => {
    const keypairString = await fs.readFile(filePath, { encoding: 'utf8' })
    const keypairBuffer = Buffer.from(JSON.parse(keypairString))
    return Keypair.fromSecretKey(keypairBuffer)
}

const sendAndWaitTransaction = async (
    transaction: VersionedTransaction
): Promise<string> => {
    const txHash = await connection.sendTransaction(transaction)
    const latestBlockHash = await connection.getLatestBlockhash();

    await connection.confirmTransaction({
        blockhash: latestBlockHash.blockhash,
        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
        signature: txHash,
    })

    return txHash
}

const createMultiSign = async (
    firstSigner: Keypair,
    secondSigner: Keypair,
    multiSignAccount: Keypair,
): Promise<string> => {
    let blockhash = await connection
        .getLatestBlockhash()
        .then((res) => res.blockhash);

    const lamportsToInitialize = await connection.getMinimumBalanceForRentExemption(INITIALIZE_MULTISIG_SPAN);

    const createAccountInstruction: TransactionInstruction = SystemProgram.createAccount({
        fromPubkey: firstSigner.publicKey,
        newAccountPubkey: multiSignAccount.publicKey,
        lamports: lamportsToInitialize,
        space: INITIALIZE_MULTISIG_SPAN,
        programId: TOKEN_PROGRAM_ID
    })

    const messageV0 = new TransactionMessage({
        payerKey: firstSigner.publicKey,
        recentBlockhash: blockhash,
        instructions: [
            createAccountInstruction,
            createInitializeMultisigInstruction(
                multiSignAccount.publicKey, 
                [
                    firstSigner.publicKey, 
                    secondSigner.publicKey
                ], 
                2
            )
        ]
    }).compileToV0Message()

    const transaction = new VersionedTransaction(messageV0)
    transaction.sign([firstSigner, multiSignAccount])
    return await sendAndWaitTransaction(transaction)
}

const createTokenMint = async (
    payerAccount: Keypair,
    tokenMintAccount: Keypair,
    mintAuthority: PublicKey
) => {
    let blockhash = await connection
        .getLatestBlockhash()
        .then((res) => res.blockhash);

    const lamportsToInitializeMint = await connection.getMinimumBalanceForRentExemption(INITIALIZE_MINT_SPAN);
    const createAccountInstruction = SystemProgram.createAccount({
      fromPubkey: payerAccount.publicKey,
      newAccountPubkey: tokenMintAccount.publicKey,
      lamports: lamportsToInitializeMint,
      space: INITIALIZE_MINT_SPAN,
      programId: TOKEN_PROGRAM_ID,
    });

    const messageV0 = new TransactionMessage({
        payerKey: payerAccount.publicKey,
        recentBlockhash: blockhash,
        instructions: [
            createAccountInstruction,
            createInitializeMintInstruction(
                tokenMintAccount.publicKey,
                0,
                mintAuthority,
                null,
            )
        ]
    }).compileToV0Message()

    const transaction = new VersionedTransaction(messageV0)
    transaction.sign([payerAccount, tokenMintAccount])
    return await sendAndWaitTransaction(transaction)
}

const mintTokenWithMultisig = async (
    tokenMint: PublicKey,
    receiver: PublicKey,
    amount: number,
    mintAuthority: PublicKey,
    signers: Keypair[]
) => {
    let blockhash = await connection
        .getLatestBlockhash()
        .then((res) => res.blockhash);

    const tokenAccount: Account = await getOrCreateAssociatedTokenAccount(
        connection,
        signers[0],
        tokenMint,
        receiver
    )
    
    const messageV0 = new TransactionMessage({
        payerKey: signers[0].publicKey,
        recentBlockhash: blockhash,
        instructions: [
            createMintToInstruction(
                tokenMint,
                tokenAccount.address,
                mintAuthority,
                amount,
                signers
            )
        ]
    }).compileToV0Message()

    const transaction = new VersionedTransaction(messageV0)
    transaction.sign(signers)

    return await sendAndWaitTransaction(transaction)
}

const main = async () => {
    // setup key pair
    const firstSigner: Keypair = await getDefaultAccount()
    const secondSigner: Keypair = Keypair.generate()

    const multiSignAccount: Keypair = Keypair.generate()
    const tokenMintAccount: Keypair = Keypair.generate()

    // create multi sig
    const createMultiSigTxHash = await createMultiSign(
        firstSigner,
        secondSigner,
        multiSignAccount
    )
    console.log("create multisig tx hash", createMultiSigTxHash)
    const multiSignData: Multisig = await getMultisig(connection, multiSignAccount.publicKey)
    console.log("Multisig data:", multiSignData)

    // create token mint
    const createTokenMintTxHash = await createTokenMint(
        firstSigner,
        tokenMintAccount,
        multiSignAccount.publicKey
    )
    console.log("create token mint tx hash", createTokenMintTxHash)
    const tokenMintData: Mint = await getMint(connection, tokenMintAccount.publicKey)
    console.log("Token mint data:", tokenMintData)

    // mint token with multisig
    const mintToTxHash = await mintTokenWithMultisig(
        tokenMintAccount.publicKey,
        firstSigner.publicKey,
        100,
        multiSignAccount.publicKey,
        [firstSigner, secondSigner]
    )

    console.log("mint to tx hash", mintToTxHash)
}

main()