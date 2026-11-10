// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * HuntersExchange order-book escrow (42 Chain, chain id 421018)
 * — src/lib/../contracts, design memo
 * ~/workspace/huntersexchange/DESIGN.md §3 (2026-11-10).
 *
 * TWO trading pairs sharing the CAW leg (v0.5.0 formal):
 *   USDT  0xC2684966e5c95B2bc636FB4a1f3Da9Ad23d94753  (18 decimals
 *         on 42 Chain — the app's shipped token registry)
 *   QOM   0x53465cbbba5b14f5dc00794330f0f4afb30eaa1d  (18 decimals,
 *         the bridged QOM token ON 42 Chain — the token the
 *         QL1<->42 QOM bridge actually delivers here. NOTE: the
 *         QL1-side WQOM address 0xa26dfBF9... has NO code on
 *         42 Chain; verified live 2026-11-10: symbol "QOM",
 *         18 decimals, at this address)
 *   CAW   0xce8aEE7148DaA8943453239C42B7b93f984A49F0  (18 decimals,
 *         the bridged "A Hunters Dream" CAW on 42 Chain)
 * Every order pairs CAW with exactly one quote token (USDT
 * or QOM); a USDT<->QOM order is not a pair and fill()
 * refuses it. Escrow accounting is per token, so the two
 * books' funds are separated by construction: an order can
 * only ever move its own two tokens between escrow accounts.
 * The book is served by merging both directions of signed
 * orders: a "sell CAW" order gives CAW and wants the quote
 * token; a "buy CAW" order gives the quote token and wants
 * CAW.
 *
 * IMMUTABLE, NO ADMIN (the user's decision 2026-11-10): no
 * owner, no upgrade path, no pause, no rescue function, no fee
 * switch. Trading fee = 0, enforced by there being no fee
 * code at all. If a bug is found, a new contract is deployed
 * and old balances are withdrawn by their owners — every
 * function below works with every server down.
 *
 * Model (design memo §3): pre-deposited escrow + off-chain
 * EIP-712 signed orders. Makers approve + deposit() tokens
 * once; each order is a signed message authorising fill()
 * against the maker's escrowed balance. fill() is callable by
 * anyone but can only move value exactly as the signature
 * says: partial fills allowed, never past the order's own
 * amount or the maker's remaining balance; an order dies at
 * its expiry or when the maker cancels it on-chain.
 * withdraw() is always available, no signature needed.
 */

// Minimal ERC-20 surface the escrow needs (non-standard
// transferFrom returns handled by the low-level call below).
interface IERC20Mini {
    function balanceOf(address account) external view returns (uint256);
}

contract HuntersExchange {
    address public constant USDT = 0xC2684966e5c95B2bc636FB4a1f3Da9Ad23d94753;
    address public constant QOM = 0x53465CbBBA5b14f5Dc00794330f0f4aFb30EAA1d;
    address public constant CAW = 0xce8aEE7148DaA8943453239C42B7b93f984A49F0;

    string public constant NAME = "HuntersExchange";
    string public constant VERSION = "1";

    // Escrowed balances: token => owner => amount.
    mapping(address => mapping(address => uint256)) public balanceOf;
    // Filled amounts per order hash (raw give-amount units).
    mapping(bytes32 => uint256) public filled;
    // Maker-cancelled orders (on-chain kill switch; the signed
    // order itself stays cryptographically valid but dead here).
    mapping(bytes32 => bool) public cancelled;

    event Deposit(address indexed user, address indexed token, uint256 amount);
    event Withdraw(address indexed user, address indexed token, uint256 amount);
    event Fill(
        bytes32 indexed orderHash,
        address indexed maker,
        address indexed taker,
        address tokenGive,
        uint256 giveAmount,
        address tokenGet,
        uint256 getAmount
    );
    event OrderCancelled(bytes32 indexed orderHash, address indexed maker);

    struct Order {
        address maker;
        address tokenGive;
        uint256 amountGive;
        address tokenGet;
        uint256 amountGet;
        uint256 expiry; // unix seconds; 0 = never
        uint256 nonce; // maker-chosen uniqueness
    }

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address tokenGive,uint256 amountGive,address tokenGet,uint256 amountGet,uint256 expiry,uint256 nonce)"
    );

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(NAME)),
                keccak256(bytes(VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    function hashOrder(Order calldata o) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                o.maker,
                o.tokenGive,
                o.amountGive,
                o.tokenGet,
                o.amountGet,
                o.expiry,
                o.nonce
            )
        );
        return keccak256(
            abi.encodePacked(bytes2(0x1901), domainSeparator(), structHash)
        );
    }

    function _isPairToken(address t) internal pure returns (bool) {
        return t == USDT || t == QOM || t == CAW;
    }

    /**
     * A fillable order pairs CAW with exactly one quote
     * token: precisely one side is CAW (the other side is
     * then USDT or QOM by _isPairToken). This is what keeps
     * the two books' escrow funds strictly separate — fill()
     * below moves ONLY the order's own tokenGive / tokenGet
     * balances, so a USDT-pair order can never touch QOM
     * escrow, and a quote<->quote order can never settle.
     */
    function _isCawPair(address give, address get) internal pure returns (bool) {
        return (give == CAW) != (get == CAW);
    }

    /**
     * Pull `amount` of `token` from the caller into escrow.
     * Uses the low-level call so tokens that do not return a
     * bool from transferFrom still work; the received amount is
     * measured by balance delta so fee-on-transfer tokens (if
     * ever whitelisted by a redeploy) escrow what actually
     * arrived. For THIS deployment all three pair tokens are
     * plain.
     */
    function deposit(address token, uint256 amount) external {
        require(_isPairToken(token), "HX: token not in pair");
        require(amount > 0, "HX: zero amount");
        uint256 before = IERC20Mini(token).balanceOf(address(this));
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSignature(
                "transferFrom(address,address,uint256)",
                msg.sender,
                address(this),
                amount
            )
        );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "HX: transferFrom failed");
        uint256 received = IERC20Mini(token).balanceOf(address(this)) - before;
        require(received > 0, "HX: nothing received");
        balanceOf[token][msg.sender] += received;
        emit Deposit(msg.sender, token, received);
    }

    /**
     * Return escrowed tokens to their owner. Always available —
     * no server, no signature, no counterparty needed.
     */
    function withdraw(address token, uint256 amount) external {
        require(_isPairToken(token), "HX: token not in pair");
        require(amount > 0, "HX: zero amount");
        require(balanceOf[token][msg.sender] >= amount, "HX: insufficient balance");
        balanceOf[token][msg.sender] -= amount;
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSignature(
                "transfer(address,uint256)",
                msg.sender,
                amount
            )
        );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "HX: transfer failed");
        emit Withdraw(msg.sender, token, amount);
    }

    /**
     * Fill `giveAmount` (raw units of the order's give token)
     * of a signed order. The taker pays the proportional get
     * amount out of their own escrowed balance; both legs move
     * inside escrow bookkeeping (no external transfers), so a
     * fill is atomic and cheap. The get amount uses the maker's
     * price, rounded UP in the taker's disfavour by at most one
     * raw unit (the maker never receives less than their rate;
     * the taker sees the exact figure before signing on-chain —
     * fill() is itself the taker's transaction).
     */
    function fill(Order calldata o, bytes calldata signature, uint256 giveAmount) external {
        require(_isPairToken(o.tokenGive) && _isPairToken(o.tokenGet), "HX: token not in pair");
        require(o.tokenGive != o.tokenGet, "HX: same token");
        require(_isCawPair(o.tokenGive, o.tokenGet), "HX: not a CAW pair");
        require(giveAmount > 0, "HX: zero fill");
        require(o.expiry == 0 || block.timestamp <= o.expiry, "HX: order expired");
        bytes32 digest = hashOrder(o);
        require(!cancelled[digest], "HX: order cancelled");
        require(filled[digest] + giveAmount <= o.amountGive, "HX: overfill");
        require(_recover(digest, signature) == o.maker, "HX: bad signature");
        require(balanceOf[o.tokenGive][o.maker] >= giveAmount, "HX: maker balance too low");
        uint256 getAmount = (giveAmount * o.amountGet + o.amountGive - 1) / o.amountGive;
        require(getAmount > 0, "HX: dust fill");
        require(balanceOf[o.tokenGet][msg.sender] >= getAmount, "HX: taker balance too low");

        filled[digest] += giveAmount;
        balanceOf[o.tokenGive][o.maker] -= giveAmount;
        balanceOf[o.tokenGive][msg.sender] += giveAmount;
        balanceOf[o.tokenGet][msg.sender] -= getAmount;
        balanceOf[o.tokenGet][o.maker] += getAmount;
        emit Fill(digest, o.maker, msg.sender, o.tokenGive, giveAmount, o.tokenGet, getAmount);
    }

    /**
     * The maker kills one of their orders on-chain. Signed
     * orders already shared stay cryptographically valid but
     * fill() refuses them from here on.
     */
    function cancelOrder(Order calldata o) external {
        require(msg.sender == o.maker, "HX: not the maker");
        bytes32 digest = hashOrder(o);
        cancelled[digest] = true;
        emit OrderCancelled(digest, msg.sender);
    }

    function _recover(bytes32 digest, bytes calldata signature)
        internal
        pure
        returns (address)
    {
        require(signature.length == 65, "HX: bad signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        require(v == 27 || v == 28, "HX: bad v");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "HX: bad signature");
        return signer;
    }
}
