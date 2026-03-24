// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract AuditHashStore {
    event HashStored(bytes32 indexed hash, address indexed sender);

    mapping(bytes32 => bool) public stored;

    function storeHash(bytes32 hash) external {
        require(hash != bytes32(0), "invalid hash");
        require(!stored[hash], "already stored");
        stored[hash] = true;
        emit HashStored(hash, msg.sender);
    }
}
