// test various flows, in multiple modes:
// once in Direct mode, and once in Relay (gasless) mode.
// the two modes must behave just the same (with an exception of gasless test, which must fail on direct mode, and must
// succeed in gasless)
// the entire 'contract' test is doubled. all tests titles are prefixed by either "Direct:" or "Relay:"

import { RelayProvider } from '../src/relayclient/RelayProvider'
import { Address } from '../src/relayclient/types/Aliases'
import {
  RelayHubInstance, StakeManagerInstance,
  TestPaymasterEverythingAcceptedInstance, TestPaymasterPreconfiguredApprovalInstance,
  TestRecipientInstance
} from '../types/truffle-contracts'
import { startRelay, stopRelay } from './TestUtils'
import { ChildProcessWithoutNullStreams } from 'child_process'
import { GSNConfig } from '../src/relayclient/GSNConfigurator'
import { PrefixedHexString } from 'ethereumjs-tx'

const TestRecipient = artifacts.require('tests/TestRecipient')
const TestPaymasterEverythingAccepted = artifacts.require('tests/TestPaymasterEverythingAccepted')
const TestPaymasterPreconfiguredApproval = artifacts.require('tests/TestPaymasterPreconfiguredApproval')

const RelayHub = artifacts.require('RelayHub')
const StakeManager = artifacts.require('StakeManager')
const Penalizer = artifacts.require('Penalizer')
const Eip712Forwarder = artifacts.require('Eip712Forwarder')

const options = [
  {
    title: 'Direct-',
    relay: false
  },
  {
    title: 'Relayed-',
    relay: true
  }
]

options.forEach(params => {
  contract(params.title + 'Flow', function (accounts) {
    let from: Address
    let sr: TestRecipientInstance
    let paymaster: TestPaymasterEverythingAcceptedInstance
    let rhub: RelayHubInstance
    let sm: StakeManagerInstance
    let gasless: Address
    let relayproc: ChildProcessWithoutNullStreams
    let relayClientConfig: Partial<GSNConfig>

    before(async () => {
      const gasPricePercent = 20

      gasless = await web3.eth.personal.newAccount('password')
      await web3.eth.personal.unlockAccount(gasless, 'password', 0)

      sm = await StakeManager.new()
      const p = await Penalizer.new()
      rhub = await RelayHub.new(sm.address, p.address, { gas: 10000000 })
      if (params.relay) {
        relayproc = await startRelay(rhub.address, sm, {
          stake: 1e18,
          delay: 3600 * 24 * 7,
          pctRelayFee: 12,
          url: 'asd',
          relayOwner: accounts[0],
          // @ts-ignore
          ethereumNodeUrl: web3.currentProvider.host,
          gasPricePercent: gasPricePercent,
          relaylog: process.env.relaylog
        })
        console.log('relay started')
        from = gasless
      } else {
        from = accounts[0]
      }

      const forwarder = await Eip712Forwarder.new()
      sr = await TestRecipient.new(forwarder.address)

      await rhub.registerRequestType(forwarder.address)

      paymaster = await TestPaymasterEverythingAccepted.new()
      await paymaster.setRelayHub(rhub.address)
    })

    after(async function () {
      await stopRelay(relayproc)
    })

    if (params.relay) {
      before(params.title + 'enable relay', async function () {
        await rhub.depositFor(paymaster.address, { value: (1e18).toString() })

        relayClientConfig = {
          relayHubAddress: rhub.address,
          stakeManagerAddress: sm.address,
          paymasterAddress: paymaster.address,
          verbose: false
        }

        // @ts-ignore
        const relayProvider = new RelayProvider(web3.currentProvider, relayClientConfig)

        // web3.setProvider(relayProvider)

        // NOTE: in real application its enough to set the provider in web3.
        // however, in Truffle, all contracts are built BEFORE the test have started, and COPIED the web3,
        // so changing the global one is not enough...
        TestRecipient.web3.setProvider(relayProvider)
      })
    }

    it(params.title + 'send normal transaction', async () => {
      console.log('running emitMessage (should succeed)')
      let res
      try {
        const gas = await sr.contract.methods.emitMessage('hello').estimateGas()
        res = await sr.emitMessage('hello', { from: from, gas })
      } catch (e) {
        console.log('error is ', e.message)
        throw e
      }
      assert.equal('hello', res.logs[0].args.message)
    })

    it(params.title + 'send gasless tranasaction', async () => {
      console.log('gasless=' + gasless)

      console.log('running gasless-emitMessage (should fail for direct, succeed for relayed)')
      let ex: Error | undefined
      try {
        const res = await sr.emitMessage('hello, from gasless', { from: gasless, gas: 1e6 })
        console.log('res after gasless emit:', res.logs[0].args.message)
      } catch (e) {
        ex = e
      }

      if (params.relay) {
        assert.ok(ex == null, `should succeed sending gasless transaction through relay. got: ${ex?.toString()}`)
      } else {
        assert.ok(ex!.toString().indexOf('funds') > 0, `Expected Error with 'funds'. got: ${ex?.toString()}`)
      }
    })
    it(params.title + 'running testRevert (should always fail)', async () => {
      await asyncShouldThrow(async () => {
        await sr.testRevert({ from: from })
      }, 'revert')
    })

    if (params.relay) {
      let approvalPaymaster: TestPaymasterPreconfiguredApprovalInstance

      describe('request with approvaldata', () => {
        let approvalData: PrefixedHexString
        before(async function () {
          approvalPaymaster = await TestPaymasterPreconfiguredApproval.new()
          await approvalPaymaster.setRelayHub(rhub.address)
          await rhub.depositFor(approvalPaymaster.address, { value: (1e18).toString() })

          const relayProvider =
            // @ts-ignore
            new RelayProvider(web3.currentProvider,
              relayClientConfig, { asyncApprovalData: async () => Promise.resolve(approvalData) })
          TestRecipient.web3.setProvider(relayProvider)
        })

        it(params.title + 'wait for specific approvalData', async () => {
          try {
            await approvalPaymaster.setExpectedApprovalData('0x414243', {
              from: accounts[0],
              useGSN: false
            })
            approvalData = '0x414243'
            await sr.emitMessage('xxx', {
              from: gasless,
              paymaster: approvalPaymaster.address
            })
          } catch (e) {
            console.log('error1: ', e)
            throw e
          } finally {
            await approvalPaymaster.setExpectedApprovalData('0x', {
              from: accounts[0],
              useGSN: false
            })
          }
        })

        it(params.title + 'fail on no approval data', async () => {
          try {
            // @ts-ignore
            await approvalPaymaster.setExpectedApprovalData(Buffer.from('hello1'), {
              from: accounts[0],
              useGSN: false
            })
            await asyncShouldThrow(async () => {
              approvalData = '0x'
              await sr.emitMessage('xxx', {
                from: gasless,
                paymaster: approvalPaymaster.address
              })
            }, 'unexpected approvalData: \'\' instead of')
          } catch (e) {
            console.log('error3: ', e)
            throw e
          } finally {
            // @ts-ignore
            await approvalPaymaster.setExpectedApprovalData(Buffer.from(''), {
              from: accounts[0],
              useGSN: false
            })
          }
        })
      })
    }

    async function asyncShouldThrow (asyncFunc: () => Promise<any>, str?: string): Promise<void> {
      const msg = str ?? 'Error'
      let ex: Error | undefined
      try {
        await asyncFunc()
      } catch (e) {
        ex = e
      }
      assert.ok(ex != null, `Expected to throw ${msg} but threw nothing`)
      const isExpectedError = ex?.toString().includes(msg)
      assert.ok(isExpectedError, `Expected to throw ${msg} but threw ${ex?.message}`)
    }
  })
})
